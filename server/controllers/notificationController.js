// Backwards-compatible facade over services/notificationService.js. Existing callers use notifyUser(); new code
// can pass `bookingId` (and optionally `category`) so the notification centre can link to the booking.
const service = require('../services/notificationService');

const VALID_NOTIFICATION_TYPES = service.VALID_TYPES;

const buildNotificationPayload = ({ userId, type, title, message, linkUrl = null, bookingId = null }) => {
  if (!userId) throw new Error('Notification requires a target userId');
  const safeType = String(type || 'SYSTEM_ALERT').toUpperCase();
  if (!VALID_NOTIFICATION_TYPES.includes(safeType)) throw new Error(`Unsupported notification type: ${type}`);
  return { userId: String(userId), type: safeType, title: String(title || 'LocalHire update').trim(), message: String(message || 'You have a new update.').trim(), linkUrl, bookingId };
};

// Never throws; returns the stored notification or null.
const notifyUser = (args) => service.notify(args);

const getNotificationsForUser = async (userId, { limit = 20 } = {}) => {
  if (!userId) return [];
  try { return (await service.list(userId, { limit })).notifications; } catch (e) { console.warn('[Notification Controller] Could not fetch notifications:', e.message); return []; }
};

const markNotificationRead = async (notificationId, userId) => {
  if (!notificationId || !userId) return null;
  try { return await service.markRead(userId, notificationId); } catch (e) { console.warn('[Notification Controller] Could not mark notification as read:', e.message); return null; }
};

module.exports = { VALID_NOTIFICATION_TYPES, buildNotificationPayload, notifyUser, getNotificationsForUser, markNotificationRead };
