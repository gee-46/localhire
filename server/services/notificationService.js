// In-app notifications: stored in PostgreSQL, pushed live over Socket.IO, and (when the user has subscribed and
// VAPID is configured) delivered as Web Push. Notifications are only ever created from real events by callers;
// there is no seeding or demo data here.
const prisma = require('../config/prisma');
const { getSocketServer } = require('../trackingState');
const push = require('./pushService');

const TYPE_CATEGORY = {
  BOOKING_REQUEST: 'BOOKING', BOOKING_CONFIRMED: 'BOOKING', BOOKING_REJECTED: 'BOOKING', BOOKING_CANCELLED: 'BOOKING', BOOKING_RESCHEDULED: 'BOOKING',
  WORKER_ON_THE_WAY: 'BOOKING', WORKER_ARRIVED: 'BOOKING', COMPLETION_REQUESTED: 'BOOKING', JOB_COMPLETED: 'BOOKING', QUOTE_RECEIVED: 'BOOKING', QUOTE_ACCEPTED: 'BOOKING',
  PAYMENT_HELD: 'PAYMENT', REFUND_PROCESSED: 'PAYMENT',
  PAYMENT_RELEASED: 'EARNINGS', EARNINGS_UPDATED: 'EARNINGS', PAYOUT_UPDATE: 'EARNINGS',
  DISPUTE_UPDATE: 'DISPUTE', NEW_MESSAGE: 'MESSAGE', REVIEW_SUBMITTED: 'SYSTEM', SYSTEM_ALERT: 'SYSTEM'
};
const VALID_TYPES = Object.keys(TYPE_CATEGORY);
const CATEGORIES = ['BOOKING', 'PAYMENT', 'MESSAGE', 'DISPUTE', 'EARNINGS', 'SYSTEM'];

const categoryFor = (type) => TYPE_CATEGORY[type] || 'SYSTEM';

const serialize = (n) => ({
  id: n.id, type: n.type, category: n.category, title: n.title, message: n.message, bookingId: n.bookingId || null,
  isRead: n.isRead, readAt: n.readAt || null, createdAt: n.createdAt
});

// Where a click should take the user. Computed here (not stored) so the rules can change without rewriting rows.
const targetUrl = (n) => {
  if (n.type === 'NEW_MESSAGE' && n.bookingId) return `/pages/chat.html?booking=${encodeURIComponent(n.bookingId)}`;
  if (n.type === 'REVIEW_SUBMITTED') return '/pages/worker-dashboard.html#reviews';
  if (n.bookingId) return `/pages/my-jobs.html?booking=${encodeURIComponent(n.bookingId)}`;
  return '/pages/notifications.html';
};

const unreadCount = (userId) => prisma.notification.count({ where: { userId: String(userId), isRead: false } });

const emitToUser = (userId, event, payload) => {
  const io = getSocketServer();
  if (io) io.to(`user:${userId}`).emit(event, payload);
};

// Is this user currently looking at the given chat room? (suppresses push/notification noise for a live chat)
const userIsInRoom = (userId, room) => {
  const io = getSocketServer();
  if (!io || !io.sockets || !io.sockets.adapter) return false;
  const ids = io.sockets.adapter.rooms.get(room);
  if (!ids) return false;
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s && s.user && String(s.user.id) === String(userId)) return true;
  }
  return false;
};

// Create + deliver. Never throws (a notification problem must never break the action that caused it).
// Returns the stored notification or null.
const notify = async ({ userId, type, title, message, bookingId = null, category = null, linkUrl = null, push: sendPush = true }) => {
  try {
    if (!userId) throw new Error('Notification requires a target userId');
    const safeType = String(type || 'SYSTEM_ALERT').toUpperCase();
    if (!VALID_TYPES.includes(safeType)) throw new Error(`Unsupported notification type: ${type}`);
    const row = await prisma.notification.create({
      data: {
        userId: String(userId), type: safeType, category: category && CATEGORIES.includes(category) ? category : categoryFor(safeType),
        title: String(title || 'LocalHire update').trim().slice(0, 140), message: String(message || 'You have a new update.').trim().slice(0, 1000),
        bookingId: bookingId ? String(bookingId) : null, linkUrl
      }
    });
    await deliver(row, sendPush);
    return row;
  } catch (error) {
    console.warn('[Notifications] Could not create notification:', error.message);
    return null;
  }
};

const deliver = async (row, sendPush) => {
  try {
    emitToUser(row.userId, 'notification:new', { notification: serialize(row), unreadCount: await unreadCount(row.userId) });
  } catch (e) { console.warn('[Notifications] live delivery failed:', e.message); }
  if (sendPush) {
    // fire and forget: a slow push service must not slow down the request
    push.sendToUser(row.userId, { title: row.title, body: row.message, url: targetUrl(row), tag: row.bookingId ? `${row.category}-${row.bookingId}`.slice(0, 80) : row.id, type: row.type, bookingId: row.bookingId })
      .catch((e) => console.warn('[Notifications] push failed:', e.message));
  }
};

// One unread "new message" notification per booking and recipient (the latest message replaces the previous
// one), so a busy chat does not flood the notification centre.
const notifyNewMessage = async ({ recipientId, senderName, bookingId, preview, recipientIsViewing }) => {
  try {
    const title = `New message from ${senderName || 'your booking contact'}`;
    const message = String(preview || '').slice(0, 140);
    if (recipientIsViewing) return null; // they are reading this very chat; the message itself is the notification
    const existing = await prisma.notification.findFirst({ where: { userId: String(recipientId), type: 'NEW_MESSAGE', bookingId, isRead: false } });
    let row;
    if (existing) row = await prisma.notification.update({ where: { id: existing.id }, data: { title, message, createdAt: new Date() } });
    else row = await prisma.notification.create({ data: { userId: String(recipientId), type: 'NEW_MESSAGE', category: 'MESSAGE', title, message, bookingId } });
    await deliver(row, true);
    return row;
  } catch (e) {
    console.warn('[Notifications] new-message notification failed:', e.message);
    return null;
  }
};

const list = async (userId, { category, unreadOnly, limit = 20, before } = {}) => {
  const take = Math.min(50, Math.max(1, Number(limit) || 20));
  const where = {
    userId: String(userId),
    ...(category && CATEGORIES.includes(String(category).toUpperCase()) ? { category: String(category).toUpperCase() } : {}),
    ...(unreadOnly ? { isRead: false } : {}),
    ...(before && !Number.isNaN(new Date(before).getTime()) ? { createdAt: { lt: new Date(before) } } : {})
  };
  const rows = await prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: take + 1 });
  const hasMore = rows.length > take;
  return { notifications: rows.slice(0, take).map(serialize), hasMore, unreadCount: await unreadCount(userId) };
};

const markRead = async (userId, id) => {
  const r = await prisma.notification.updateMany({ where: { id: String(id), userId: String(userId), isRead: false }, data: { isRead: true, readAt: new Date() } });
  const count = await unreadCount(userId);
  emitToUser(userId, 'notification:unread', { unreadCount: count });
  return { updated: r.count, unreadCount: count };
};

const markAllRead = async (userId, { category } = {}) => {
  const r = await prisma.notification.updateMany({
    where: { userId: String(userId), isRead: false, ...(category && CATEGORIES.includes(String(category).toUpperCase()) ? { category: String(category).toUpperCase() } : {}) },
    data: { isRead: true, readAt: new Date() }
  });
  const count = await unreadCount(userId);
  emitToUser(userId, 'notification:unread', { unreadCount: count });
  return { updated: r.count, unreadCount: count };
};

// Chat opened: its "new message" notification is no longer news.
const markBookingMessagesRead = async (userId, bookingId) => {
  await prisma.notification.updateMany({ where: { userId: String(userId), bookingId: String(bookingId), type: 'NEW_MESSAGE', isRead: false }, data: { isRead: true, readAt: new Date() } });
  emitToUser(userId, 'notification:unread', { unreadCount: await unreadCount(userId) });
};

module.exports = { VALID_TYPES, CATEGORIES, categoryFor, serialize, targetUrl, unreadCount, notify, notifyNewMessage, list, markRead, markAllRead, markBookingMessagesRead, userIsInRoom };
