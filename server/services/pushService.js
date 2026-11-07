// Web Push (browser notifications that can arrive while LocalHire is not open).
//
// Configuration (server/.env, see .env.example):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   generate once with:  npm --prefix server run push:generate-keys
//   VAPID_SUBJECT                           "mailto:you@example.com" or an https URL identifying the sender
// The PRIVATE key never leaves the server; only the public key is handed to browsers.
//
// What this module does NOT do: it cannot make a browser deliver a notification. Delivery goes through the
// browser vendor's push service (FCM, Mozilla autopush, Apple). sendToUser() reports exactly what each push
// service answered; "sent" means the push service accepted the message, not that a person saw it.
const webpush = require('web-push');
const prisma = require('../config/prisma');

const MAX_FAILURES = 5;
const MAX_PAYLOAD_BYTES = 3000; // push services reject ~4KB; stay well below

const vapid = () => ({
  publicKey: (process.env.VAPID_PUBLIC_KEY || '').trim(),
  privateKey: (process.env.VAPID_PRIVATE_KEY || '').trim(),
  subject: (process.env.VAPID_SUBJECT || '').trim()
});

const isPlaceholder = (v) => !v || /replace_with|your_/i.test(v);

const isConfigured = () => {
  const v = vapid();
  return !isPlaceholder(v.publicKey) && !isPlaceholder(v.privateKey) && /^(mailto:|https:\/\/)/.test(v.subject);
};

const getPublicKey = () => (isConfigured() ? vapid().publicKey : null);

// (subscription, payloadString, options) => Promise<{statusCode}>. Replaced in tests by a recording fake.
let sender = async (subscription, payload, options) => {
  const v = vapid();
  return webpush.sendNotification(subscription, payload, { ...options, vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey } });
};
const setSender = (fn) => { sender = fn || null; };

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// Validates what a browser's PushSubscription.toJSON() gives us.
const validateSubscription = (sub) => {
  if (!sub || typeof sub !== 'object') return 'A push subscription is required.';
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return 'Invalid push endpoint.';
  let url;
  try { url = new URL(endpoint); } catch (e) { return 'Invalid push endpoint.'; }
  if (url.protocol !== 'https:') return 'Push endpoints must use https.';
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || !B64URL.test(keys.p256dh) || !B64URL.test(keys.auth) || keys.p256dh.length > 200 || keys.auth.length > 100) return 'Invalid push keys.';
  return null;
};

// One row per browser endpoint. If the same browser is used by another account, the subscription moves to the
// account that is logged in now, so notifications never reach the previous user.
const subscribe = async (userId, sub, userAgent) => {
  const err = validateSubscription(sub);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ? String(userAgent).slice(0, 300) : null },
    update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent: userAgent ? String(userAgent).slice(0, 300) : null, failureCount: 0 }
  });
  return { id: row.id };
};

const unsubscribe = async (userId, endpoint) => {
  if (typeof endpoint !== 'string' || !endpoint) return 0;
  const r = await prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
  return r.count;
};

const countForUser = (userId) => prisma.pushSubscription.count({ where: { userId } });

const buildPayload = ({ title, body, url, tag, type, bookingId }) => {
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  let payload = { title: clip(title, 100), body: clip(body, 160), url: clip(url, 300), tag: clip(tag, 80), type: clip(type, 40), bookingId: bookingId || null };
  let text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) { payload = { ...payload, body: clip(body, 60) }; text = JSON.stringify(payload); }
  return text;
};

// Never throws. Returns { configured, attempted, sent, expired, failed }.
const sendToUser = async (userId, message) => {
  const result = { configured: isConfigured(), attempted: 0, sent: 0, expired: 0, failed: 0 };
  if (!sender || !result.configured) return result;
  let subs;
  try { subs = await prisma.pushSubscription.findMany({ where: { userId } }); } catch (e) { console.warn('[Push] could not load subscriptions:', e.message); return result; }
  if (!subs.length) return result;
  const payload = buildPayload(message);
  await Promise.all(subs.map(async (s) => {
    result.attempted += 1;
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24, urgency: 'normal', ...(message.tag ? { topic: String(message.tag).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined } : {}) });
      result.sent += 1;
      await prisma.pushSubscription.update({ where: { id: s.id }, data: { failureCount: 0, lastSuccessAt: new Date() } }).catch(() => {});
    } catch (e) {
      const status = e && (e.statusCode || e.status);
      if (status === 404 || status === 410) {
        // The push service says this subscription no longer exists (user revoked permission, cleared data, uninstalled).
        result.expired += 1;
        await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        return;
      }
      result.failed += 1;
      const failures = s.failureCount + 1;
      console.warn(`[Push] delivery to ${new URL(s.endpoint).host} failed (${status || e.code || e.message})`);
      if (failures >= MAX_FAILURES) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      else await prisma.pushSubscription.update({ where: { id: s.id }, data: { failureCount: failures, lastFailureAt: new Date() } }).catch(() => {});
    }
  }));
  return result;
};

module.exports = { isConfigured, getPublicKey, subscribe, unsubscribe, countForUser, sendToUser, setSender, validateSubscription, buildPayload, MAX_FAILURES };
