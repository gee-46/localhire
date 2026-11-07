// Booking-scoped chat. A conversation exists only for a real booking and only its customer and assigned worker can
// read or write it. Admins have no chat access (the existing policy); support works through disputes instead.
const prisma = require('../config/prisma');
const { getSocketServer } = require('../trackingState');
const notifications = require('./notificationService');

const MESSAGE_MAX_LENGTH = 2000;
const COMPLETED_CHAT_DAYS = 14;
const roomFor = (bookingId) => `chat:${bookingId}`;

class ChatError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

// Light per-user send limiter (messages per minute), shared by REST and socket paths.
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const sendLog = new Map();
const checkRate = (userId) => {
  const now = Date.now();
  const recent = (sendLog.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { sendLog.set(userId, recent); throw new ChatError(429, 'You are sending messages too quickly. Please wait a moment.', 'RATE_LIMITED'); }
  recent.push(now);
  sendLog.set(userId, recent);
};

const participantRole = (booking, userId) => (booking.customerId === userId ? 'Customer' : booking.workerId === userId ? 'Worker' : null);

// → { booking, role, canSend, readOnlyReason }. Throws ChatError(404|403).
const loadBooking = async (bookingId, userId) => {
  if (!bookingId || typeof bookingId !== 'string') throw new ChatError(400, 'A booking is required.', 'BAD_REQUEST');
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, bookingNumber: true, status: true, scheduledAt: true, completedAt: true, cancelledAt: true, customerId: true, workerId: true,
      problemDescription: true, serviceItem: { select: { title: true } },
      customer: { select: { id: true, name: true, avatarUrl: true } },
      worker: { select: { id: true, name: true, avatarUrl: true, workerProfile: { select: { primaryCategory: { select: { name: true } } } } } }
    }
  });
  if (!booking) throw new ChatError(404, 'Booking not found.', 'NOT_FOUND');
  const role = participantRole(booking, String(userId));
  if (!role) throw new ChatError(403, 'You are not part of this booking, so you cannot access its conversation.', 'FORBIDDEN');
  let readOnlyReason = null;
  if (booking.status === 'CANCELLED') readOnlyReason = 'This booking was cancelled. You can read the conversation but not send new messages.';
  else if (booking.status === 'COMPLETED' && booking.completedAt && Date.now() - new Date(booking.completedAt).getTime() > COMPLETED_CHAT_DAYS * 86400000) {
    readOnlyReason = `This booking was completed more than ${COMPLETED_CHAT_DAYS} days ago, so the conversation is read-only.`;
  }
  return { booking, role, canSend: !readOnlyReason, readOnlyReason };
};

const counterpartOf = (booking, role) => (role === 'Customer' ? booking.worker : booking.customer);
const counterpartView = (booking, role) => {
  const c = counterpartOf(booking, role);
  return {
    id: c.id, name: c.name || (role === 'Customer' ? 'Professional' : 'Customer'), avatarUrl: c.avatarUrl || null,
    role: role === 'Customer' ? 'Worker' : 'Customer',
    subtitle: role === 'Customer' ? ((booking.worker.workerProfile && booking.worker.workerProfile.primaryCategory && booking.worker.workerProfile.primaryCategory.name) || 'Service professional') : 'Customer'
  };
};
const bookingView = (b) => ({
  id: b.id, bookingNumber: b.bookingNumber, status: b.status, scheduledAt: b.scheduledAt,
  service: (b.serviceItem && b.serviceItem.title) || b.problemDescription || 'Service booking'
});

const serializeMessage = (m) => ({
  id: m.id, bookingId: m.bookingId, conversationId: m.conversationId, senderId: m.senderId, receiverId: m.receiverId,
  content: m.content, createdAt: m.createdAt, isRead: m.isRead, readAt: m.readAt || null, clientMessageId: m.clientMessageId || null,
  // legacy field names used by older clients
  sender: m.senderId, receiver: m.receiverId
});

const ensureConversation = async (booking) => {
  const [user1Id, user2Id] = [booking.customerId, booking.workerId].sort();
  try {
    return await prisma.conversation.upsert({ where: { bookingId: booking.id }, create: { bookingId: booking.id, user1Id, user2Id }, update: {} });
  } catch (e) {
    // two first messages raced to create the conversation: the other one won, use it
    if (e.code === 'P2002') return prisma.conversation.findUnique({ where: { bookingId: booking.id } });
    throw e;
  }
};

const cleanContent = (content) => {
  const text = typeof content === 'string' ? content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() : '';
  if (!text) throw new ChatError(400, 'Message content is required.', 'EMPTY');
  if (text.length > MESSAGE_MAX_LENGTH) throw new ChatError(400, `Message is too long. Maximum length is ${MESSAGE_MAX_LENGTH} characters.`, 'TOO_LONG');
  return text;
};

const cleanClientId = (id) => {
  if (id === undefined || id === null || id === '') return null;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new ChatError(400, 'Invalid clientMessageId.', 'BAD_CLIENT_ID');
  return id;
};

// Idempotent: the same (sender, clientMessageId) always returns the same stored message and never creates a second one.
const sendMessage = async ({ bookingId, senderId, content, clientMessageId }) => {
  const sender = String(senderId);
  const { booking, role, canSend, readOnlyReason } = await loadBooking(bookingId, sender);
  const text = cleanContent(content);
  const clientId = cleanClientId(clientMessageId);

  // A retry of something already stored is answered from the database, before any other check (the first attempt
  // was valid when it was made).
  if (clientId) {
    const dup = await prisma.chatMessage.findUnique({ where: { senderId_clientMessageId: { senderId: sender, clientMessageId: clientId } } });
    if (dup) return { message: serializeMessage({ ...dup, bookingId }), duplicate: true };
  }
  if (!canSend) throw new ChatError(409, readOnlyReason, 'READ_ONLY');
  checkRate(sender);

  const receiverId = role === 'Customer' ? booking.workerId : booking.customerId;
  const conversation = await ensureConversation(booking);
  let message;
  try {
    message = await prisma.chatMessage.create({ data: { conversationId: conversation.id, senderId: sender, receiverId, content: text, isRead: false, clientMessageId: clientId } });
  } catch (e) {
    if (e.code === 'P2002' && clientId) { // two identical retries raced: the other one won
      const dup = await prisma.chatMessage.findUnique({ where: { senderId_clientMessageId: { senderId: sender, clientMessageId: clientId } } });
      if (dup) return { message: serializeMessage({ ...dup, bookingId }), duplicate: true };
    }
    throw e;
  }
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: message.createdAt } });

  const payload = serializeMessage({ ...message, bookingId });
  const io = getSocketServer();
  if (io) {
    io.to(roomFor(bookingId)).emit('chat:message', payload);
    io.to(roomFor(bookingId)).emit('receive_message', payload); // legacy event name
    const unread = await unreadFor(receiverId);
    io.to(`user:${receiverId}`).emit('chat:unread', { bookingId, ...unread });
    io.to(`user:${sender}`).emit('conversation:updated', { conversationId: conversation.id, bookingId, message: payload });
    io.to(`user:${receiverId}`).emit('conversation:updated', { conversationId: conversation.id, bookingId, message: payload });
  }
  const senderName = (role === 'Customer' ? booking.customer.name : booking.worker.name) || (role === 'Customer' ? 'Customer' : 'Professional');
  notifications.notifyNewMessage({
    recipientId: receiverId, senderName, bookingId, preview: text, recipientIsViewing: notifications.userIsInRoom(receiverId, roomFor(bookingId))
  });
  return { message: payload, duplicate: false };
};

const listMessages = async ({ bookingId, userId, before, after, limit }) => {
  const ctx = await loadBooking(bookingId, String(userId));
  const conversation = await prisma.conversation.findUnique({ where: { bookingId } });
  const take = Math.min(100, Math.max(1, Number(limit) || 50));
  let messages = [];
  let hasMore = false;
  if (conversation) {
    const dateOk = (v) => v && !Number.isNaN(new Date(v).getTime());
    if (dateOk(after)) {
      // catch-up after a reconnect: everything newer than what the client already has, oldest first
      messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id, createdAt: { gt: new Date(after) } }, orderBy: { createdAt: 'asc' }, take: 200 });
    } else {
      const rows = await prisma.chatMessage.findMany({
        where: { conversationId: conversation.id, ...(dateOk(before) ? { createdAt: { lt: new Date(before) } } : {}) },
        orderBy: { createdAt: 'desc' }, take: take + 1
      });
      hasMore = rows.length > take;
      messages = rows.slice(0, take).reverse();
    }
  }
  return { ...ctx, messages: messages.map((m) => serializeMessage({ ...m, bookingId })), hasMore };
};

const unreadFor = async (userId) => {
  const groups = await prisma.chatMessage.groupBy({
    by: ['conversationId'], where: { receiverId: String(userId), isRead: false, conversation: { bookingId: { not: null } } }, _count: { id: true }
  });
  return { total: groups.reduce((a, g) => a + g._count.id, 0), byConversation: Object.fromEntries(groups.map((g) => [g.conversationId, g._count.id])) };
};

const markRead = async ({ bookingId, userId }) => {
  await loadBooking(bookingId, String(userId));
  const conversation = await prisma.conversation.findUnique({ where: { bookingId } });
  if (!conversation) return { marked: 0 };
  const readAt = new Date();
  const r = await prisma.chatMessage.updateMany({ where: { conversationId: conversation.id, receiverId: String(userId), isRead: false }, data: { isRead: true, readAt } });
  await notifications.markBookingMessagesRead(userId, bookingId);
  const io = getSocketServer();
  if (io && r.count) {
    io.to(roomFor(bookingId)).emit('chat:read', { bookingId, readerId: String(userId), readAt });
    io.to(`user:${userId}`).emit('chat:unread', { bookingId, ...(await unreadFor(userId)) });
  }
  return { marked: r.count };
};

const listConversations = async (userId) => {
  const me = String(userId);
  const conversations = await prisma.conversation.findMany({
    where: { bookingId: { not: null }, OR: [{ user1Id: me }, { user2Id: me }], messages: { some: {} } },
    orderBy: { lastMessageAt: 'desc' }, take: 100,
    include: {
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      booking: {
        select: {
          id: true, bookingNumber: true, status: true, scheduledAt: true, customerId: true, workerId: true, problemDescription: true, serviceItem: { select: { title: true } },
          customer: { select: { id: true, name: true, avatarUrl: true } },
          worker: { select: { id: true, name: true, avatarUrl: true, workerProfile: { select: { primaryCategory: { select: { name: true } } } } } }
        }
      }
    }
  });
  const unread = await unreadFor(me);
  const items = conversations.filter((c) => c.booking && (c.booking.customerId === me || c.booking.workerId === me)).map((c) => {
    const role = participantRole(c.booking, me);
    const last = c.messages[0];
    return {
      conversationId: c.id, bookingId: c.booking.id, booking: bookingView(c.booking), counterpart: counterpartView(c.booking, role),
      lastMessage: last ? { id: last.id, content: last.content, senderId: last.senderId, createdAt: last.createdAt } : null,
      timestamp: last ? last.createdAt : c.lastMessageAt, unreadCount: unread.byConversation[c.id] || 0
    };
  });
  return { conversations: items, totalUnread: unread.total };
};

// Legacy pair-based lookups (older clients): resolve to the most recent real booking between the two users.
const latestBookingBetween = async (userId, otherUserId) => {
  if (!userId || !otherUserId || String(userId) === String(otherUserId)) return null;
  return prisma.booking.findFirst({
    where: { OR: [{ customerId: String(userId), workerId: String(otherUserId) }, { customerId: String(otherUserId), workerId: String(userId) }] },
    orderBy: { createdAt: 'desc' }, select: { id: true }
  });
};

module.exports = {
  ChatError, MESSAGE_MAX_LENGTH, roomFor, loadBooking, counterpartView, bookingView, serializeMessage, sendMessage, listMessages, markRead,
  listConversations, unreadFor, latestBookingBetween, checkRate
};
