// HTTP layer for chat. Every route resolves to a booking and is authorised by chatService.loadBooking (customer or
// assigned worker only). The older user-pair routes are kept for compatibility and resolve to the most recent
// real booking between the two users.
const prisma = require('../config/prisma');
const chat = require('../services/chatService');

const uid = (req) => String(req.user.id);

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof chat.ChatError) return res.status(e.status).json({ success: false, message: e.message, code: e.code });
    console.error('[Chat Controller]', e);
    return res.status(500).json({ success: false, message: 'Server error while processing the chat request.' });
  }
};

// GET /api/chat/conversations
exports.getConversations = handle(async (req, res) => {
  const { conversations, totalUnread } = await chat.listConversations(uid(req));
  res.json({ success: true, count: conversations.length, totalUnread, conversations });
});

// GET /api/chat/unread-count
exports.getUnreadCount = handle(async (req, res) => {
  const u = await chat.unreadFor(uid(req));
  res.json({ success: true, total: u.total });
});

// GET /api/chat/bookings/:bookingId  (header information for the chat screen)
exports.getBookingChat = handle(async (req, res) => {
  const { booking, role, canSend, readOnlyReason } = await chat.loadBooking(req.params.bookingId, uid(req));
  res.json({ success: true, booking: chat.bookingView(booking), counterpart: chat.counterpartView(booking, role), role, canSend, readOnlyReason });
});

// GET /api/chat/bookings/:bookingId/messages?before=&after=&limit=
exports.getBookingMessages = handle(async (req, res) => {
  const r = await chat.listMessages({ bookingId: req.params.bookingId, userId: uid(req), before: req.query.before, after: req.query.after, limit: req.query.limit });
  res.json({ success: true, booking: chat.bookingView(r.booking), counterpart: chat.counterpartView(r.booking, r.role), role: r.role, canSend: r.canSend, readOnlyReason: r.readOnlyReason, hasMore: r.hasMore, count: r.messages.length, messages: r.messages });
});

// POST /api/chat/bookings/:bookingId/messages  { content, clientMessageId }
exports.postBookingMessage = handle(async (req, res) => {
  const out = await chat.sendMessage({ bookingId: req.params.bookingId, senderId: uid(req), content: req.body && req.body.content, clientMessageId: req.body && req.body.clientMessageId });
  res.status(out.duplicate ? 200 : 201).json({ success: true, duplicate: out.duplicate, message: out.message });
});

// POST /api/chat/bookings/:bookingId/read
exports.markBookingRead = handle(async (req, res) => {
  const r = await chat.markRead({ bookingId: req.params.bookingId, userId: uid(req) });
  res.json({ success: true, markedCount: r.marked });
});

// ── legacy, user-pair based routes ───────────────────────────────────────────

exports.getMessages = handle(async (req, res) => {
  const booking = await chat.latestBookingBetween(uid(req), req.params.otherUserId);
  if (!booking) return res.status(403).json({ success: false, message: 'You can only message the customer or worker associated with a valid booking.' });
  const r = await chat.listMessages({ bookingId: booking.id, userId: uid(req), limit: 100 });
  await chat.markRead({ bookingId: booking.id, userId: uid(req) }).catch(() => {});
  res.json({ success: true, bookingId: booking.id, count: r.messages.length, messages: r.messages });
});

exports.sendMessage = handle(async (req, res) => {
  const { receiverId, content, clientMessageId } = req.body || {};
  if (!receiverId) return res.status(400).json({ success: false, message: 'Receiver ID is required' });
  const booking = await chat.latestBookingBetween(uid(req), receiverId);
  if (!booking) return res.status(403).json({ success: false, message: 'You can only message the customer or worker associated with a valid booking.' });
  const out = await chat.sendMessage({ bookingId: booking.id, senderId: uid(req), content, clientMessageId });
  res.status(out.duplicate ? 200 : 201).json({ success: true, duplicate: out.duplicate, message: out.message });
});

// PATCH /api/chat/conversations/:id/read  (:id = conversation id)
exports.markAsRead = handle(async (req, res) => {
  const conversation = await prisma.conversation.findUnique({ where: { id: String(req.params.id) } });
  if (!conversation || !conversation.bookingId) return res.status(404).json({ success: false, message: 'Conversation not found' });
  const r = await chat.markRead({ bookingId: conversation.bookingId, userId: uid(req) });
  res.json({ success: true, message: 'Messages marked as read', markedCount: r.marked, conversationId: conversation.id });
});

// GET /api/chat/user/:id — only people you share a booking with
exports.getChatUser = handle(async (req, res) => {
  const booking = await chat.latestBookingBetween(uid(req), req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'User not found' });
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, avatarUrl: true, role: true, workerProfile: { select: { businessName: true, primaryCategory: { select: { name: true } } } } }
  });
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({
    success: true, bookingId: booking.id,
    user: {
      id: user.id, name: user.name, avatarUrl: user.avatarUrl, avatar: user.avatarUrl,
      role: user.role === 'WORKER' ? 'Worker' : (user.role === 'ADMIN' ? 'Admin' : 'Customer'),
      subtitle: (user.workerProfile && ((user.workerProfile.primaryCategory && user.workerProfile.primaryCategory.name) || user.workerProfile.businessName)) || (user.role === 'WORKER' ? 'Service Professional' : 'Customer')
    }
  });
});

exports.normalizeMessage = chat.serializeMessage;
