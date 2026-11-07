// Notifications and Web Push: real routes, real PostgreSQL, real Socket.IO.
// Push delivery itself cannot be tested here (it needs a browser vendor's push service), so the Web Push transport is
// replaced by a recording fake. These tests prove what LocalHire sends, to whom and how it reacts to the push service's
// answers (success, expired 404/410, transient failure). They do NOT prove a notification appears on a device.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_notiftest001';
process.env.RAZORPAY_KEY_SECRET = 'notif_test_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'notif_test_webhook_secret';
process.env.PAYMENT_RATE_LIMIT_MAX = '10000';
process.env.PUSH_RATE_LIMIT_MAX = '10000';
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT;
delete process.env.PAYOUT_MODE;

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { setRazorpayInstance } = require('../config/razorpay');
const push = require('../services/pushService');
const routeClient = require('../services/routeClient');
const { server } = require('../server');
const { FakeRazorpay, FakeRoute, checkoutSignature, webhookSignature } = require('./helpers/fakeRazorpay');

const tag = `ntf${Date.now()}`;
const created = [];
const sockets = [];
const gw = new FakeRazorpay();
let base; let plumber; let seq = 0;

async function api(method, path, { token, json, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let body;
  if (raw !== undefined) { body = raw; h['Content-Type'] = 'application/json'; } else if (json) { body = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
  const res = await fetch(base + path, { method, headers: h, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}
async function makeUser(label, role) {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210' } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}
async function makeWorker(label) {
  const w = await makeUser(label, 'WORKER');
  const profile = await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus: 'VERIFIED', hourlyRate: 300, bio: 'Plumber' } });
  await prisma.workerLocation.create({ data: { workerProfileId: profile.id, latitude: 15.85, longitude: 74.51, lastLocationUpdate: new Date(), isAvailable: true, sharingEnabled: true } });
  return w;
}
const makeBooking = (c, w, status = 'CONFIRMED', extra = {}) => prisma.booking.create({
  data: { bookingNumber: `BK-${tag}-${++seq}`, customerId: c.user.id, workerId: w.user.id, status, agreedPrice: 1000, scheduledAt: new Date(Date.now() + 86400000), problemDescription: 'Kitchen tap leaking', priceConfirmedAt: new Date(), ...extra }
});
const notesFor = (userId, where = {}) => prisma.notification.findMany({ where: { userId, ...where }, orderBy: { createdAt: 'asc' } });
const status = (token, id, s, extra = {}) => api('PUT', `/api/bookings/${id}/status`, { token, json: { status: s, ...extra } });
const future = (days = 3) => new Date(Date.now() + days * 86400000).toISOString();

function connect(token) {
  const socket = ioClient(base, { auth: { token }, transports: ['websocket'], forceNew: true });
  const received = [];
  socket.onAny((event, ...args) => received.push({ event, args }));
  const c = {
    socket, received,
    ready: () => new Promise((resolve, reject) => { if (socket.connected) return resolve(); socket.once('connect', resolve); socket.once('connect_error', reject); }),
    when: (event, match, ms = 4000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => { const hit = received.find((r) => r.event === event && (!match || match(...r.args))); if (hit) return resolve(hit.args[0]); if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${event}`)); setTimeout(tick, 20); };
      tick();
    })
  };
  sockets.push(socket);
  return c;
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  setRazorpayInstance(gw);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(() => { gw.reset(); push.setSender(null); delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.VAPID_SUBJECT; });
test.after(async () => {
  sockets.forEach((s) => s.close());
  const q = { where: { OR: [{ customerId: { in: created } }, { workerId: { in: created } }] } };
  const pays = (await prisma.payment.findMany({ ...q, select: { id: true } })).map((p) => p.id);
  const bookings = (await prisma.booking.findMany({ ...q, select: { id: true } })).map((b) => b.id);
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: pays } } }).catch(() => {});
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: pays } } }).catch(() => {});
  await prisma.workerSettlement.deleteMany({ where: { paymentId: { in: pays } } }).catch(() => {});
  await prisma.payment.deleteMany({ where: { id: { in: pays } } }).catch(() => {});
  await prisma.supportTicket.deleteMany({ where: { bookingId: { in: bookings } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: created } }, { entityId: { in: pays } }] } }).catch(() => {});
  await prisma.workerPayoutAccount.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.pushSubscription.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.chatMessage.deleteMany({ where: { OR: [{ senderId: { in: created } }, { receiverId: { in: created } }] } }).catch(() => {});
  await prisma.conversation.deleteMany({ where: { bookingId: { in: bookings } } }).catch(() => {});
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookings } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { id: { in: bookings } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  setRazorpayInstance(null);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ─── Booking lifecycle notifications ────────────────────────────────────────

test('booking request: the worker is told with the real job description; the customer gets a submitted confirmation', async () => {
  const c = await makeUser('rq-c', 'CUSTOMER'); const w = await makeWorker('rq-w');
  const r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: future(), timeSlot: '10:00 - 12:00', agreedPrice: 500, problemDescription: 'The bathroom tap is dripping.' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const bookingId = r.data.booking.id;
  const [wn] = await notesFor(w.user.id);
  assert.equal(wn.type, 'BOOKING_REQUEST'); assert.equal(wn.category, 'BOOKING'); assert.equal(wn.bookingId, bookingId);
  assert.match(wn.message, /The bathroom tap is dripping/);
  const [cn] = await notesFor(c.user.id);
  assert.equal(cn.title, 'Booking request submitted'); assert.equal(cn.bookingId, bookingId);
  assert.equal(cn.isRead, false);
});

test('customer notifications: accepted, declined, rescheduled, on the way, arrived, completion requested, cancelled by worker', async () => {
  const c = await makeUser('lc-c', 'CUSTOMER'); const w = await makeWorker('lc-w');
  const typesOf = async (b) => (await notesFor(c.user.id, { bookingId: b.id })).map((n) => n.type);

  // accepted -> rescheduled -> on the way -> arrived -> completion requested
  const b1 = await makeBooking(c, w, 'REQUESTED', { priceConfirmedAt: null });
  assert.equal((await status(w.token, b1.id, 'CONFIRMED', { agreedPrice: 1200 })).status, 200);
  const resch = await api('PATCH', `/api/bookings/${b1.id}/reschedule`, { token: w.token, json: { scheduledAt: future(5), reason: 'Another job overran' } });
  assert.equal(resch.status, 200, JSON.stringify(resch.data));
  assert.equal((await status(w.token, b1.id, 'DISPATCHED')).status, 200);
  assert.equal((await status(w.token, b1.id, 'IN_PROGRESS')).status, 200);
  assert.equal((await status(w.token, b1.id, 'AWAITING_CUSTOMER_CONFIRMATION')).status, 200);
  assert.deepEqual(await typesOf(b1), ['BOOKING_CONFIRMED', 'BOOKING_RESCHEDULED', 'WORKER_ON_THE_WAY', 'WORKER_ARRIVED', 'COMPLETION_REQUESTED']);
  const accepted = (await notesFor(c.user.id, { bookingId: b1.id, type: 'BOOKING_CONFIRMED' }))[0];
  assert.match(accepted.message, /1200/);
  const resched = (await notesFor(c.user.id, { bookingId: b1.id, type: 'BOOKING_RESCHEDULED' }))[0];
  assert.match(resched.message, /Another job overran/);

  // declined
  const b2 = await makeBooking(c, w, 'REQUESTED', { priceConfirmedAt: null });
  await status(w.token, b2.id, 'CANCELLED');
  assert.deepEqual(await typesOf(b2), ['BOOKING_REJECTED']);
  // cancelled by the worker after accepting
  const b3 = await makeBooking(c, w, 'CONFIRMED');
  await status(w.token, b3.id, 'CANCELLED', { notes: 'Van broke down' });
  assert.deepEqual(await typesOf(b3), ['BOOKING_CANCELLED']);
  assert.match((await notesFor(c.user.id, { bookingId: b3.id }))[0].title, /by the professional/);
  // a notification is never created for the person who did the action
  assert.equal(await prisma.notification.count({ where: { userId: w.user.id, bookingId: b2.id } }), 0);
});

test('reschedule rules: assigned worker only, before the journey starts, in the future, within working hours, with a reason', async () => {
  const c = await makeUser('rs-c', 'CUSTOMER'); const w = await makeWorker('rs-w'); const w2 = await makeWorker('rs-w2');
  const b = await makeBooking(c, w, 'CONFIRMED');
  const go = (token, json) => api('PATCH', `/api/bookings/${b.id}/reschedule`, { token, json });
  assert.equal((await go(c.token, { scheduledAt: future(4), reason: 'x y z' })).status, 403, 'customers cannot reschedule through this route');
  assert.equal((await go(w2.token, { scheduledAt: future(4), reason: 'not my job' })).status, 403);
  assert.equal((await go(w.token, { scheduledAt: 'garbage', reason: 'bad date' })).status, 400);
  assert.equal((await go(w.token, { scheduledAt: new Date(Date.now() - 3600000).toISOString(), reason: 'past' })).status, 400);
  assert.equal((await go(w.token, { scheduledAt: future(4), reason: '' })).status, 400);
  // working hours: only Mondays 09:00-10:00 IST
  const profile = await prisma.workerProfile.findUnique({ where: { userId: w.user.id } });
  await prisma.professionalAvailability.create({ data: { workerProfileId: profile.id, dayOfWeek: 1, startTime: '09:00', endTime: '10:00', isActive: true } });
  const sunday = new Date(Date.now() + 3 * 86400000); while (new Date(sunday.getTime() + 330 * 60000).getUTCDay() !== 0) sunday.setUTCDate(sunday.getUTCDate() + 1);
  assert.equal((await go(w.token, { scheduledAt: sunday.toISOString(), reason: 'on a day off' })).data.code, 'OUTSIDE_WORKING_HOURS');
  await prisma.professionalAvailability.deleteMany({ where: { workerProfileId: profile.id } });
  assert.equal((await go(w.token, { scheduledAt: future(4), reason: 'Another job overran' })).status, 200);
  await status(w.token, b.id, 'DISPATCHED');
  assert.equal((await go(w.token, { scheduledAt: future(6), reason: 'too late now' })).status, 409, 'not once the journey started');
  assert.equal(await prisma.notification.count({ where: { userId: c.user.id, type: 'BOOKING_RESCHEDULED' } }), 1);
});

test('worker notifications: cancelled by the customer, quote accepted', async () => {
  const c = await makeUser('wn-c', 'CUSTOMER'); const w = await makeWorker('wn-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  await status(c.token, b.id, 'CANCELLED', { notes: 'Plans changed' });
  const n = (await notesFor(w.user.id, { bookingId: b.id }))[0];
  assert.equal(n.type, 'BOOKING_CANCELLED'); assert.match(n.title, /customer/i);

  const job = await prisma.jobPost.create({ data: { customerId: c.user.id, categoryId: plumber.id, title: `${tag} quote job`, description: 'Replace the old geyser in the bathroom.' } });
  const app = await api('POST', '/api/applications', { token: w.token, json: { jobId: job.id, quote: 1500, message: 'I can do this' } });
  const acc = await api('PUT', `/api/applications/${app.data.application.id}/accept`, { token: c.token });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  const q = (await notesFor(w.user.id, { type: 'QUOTE_ACCEPTED' }))[0];
  assert.equal(q.bookingId, acc.data.bookingId); assert.match(q.message, /1500/);
  await prisma.jobApplication.deleteMany({ where: { jobId: job.id } });
  await prisma.conversation.deleteMany({ where: { bookingId: acc.data.bookingId } });
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: acc.data.bookingId } });
  await prisma.notification.deleteMany({ where: { bookingId: acc.data.bookingId } });
  await prisma.booking.delete({ where: { id: acc.data.bookingId } });
  await prisma.jobPost.delete({ where: { id: job.id } });
});

test('payment, completion, earnings, refund and dispute notifications reach the right person', async () => {
  const c = await makeUser('py-c', 'CUSTOMER'); const w = await makeWorker('py-w'); const admin = await makeUser('py-a', 'ADMIN');
  const b = await makeBooking(c, w, 'IN_PROGRESS');
  const o = await api('POST', `/api/payments/booking/${b.id}/order`, { token: c.token });
  const ent = gw.pay(o.data.orderId);
  assert.equal((await api('POST', `/api/payments/booking/${b.id}/verify`, { token: c.token, json: { razorpay_order_id: o.data.orderId, razorpay_payment_id: ent.id, razorpay_signature: checkoutSignature(process.env.RAZORPAY_KEY_SECRET, o.data.orderId, ent.id) } })).status, 200);
  assert.equal((await notesFor(c.user.id, { bookingId: b.id, type: 'PAYMENT_HELD' }))[0].title, 'Payment successful');
  assert.equal((await notesFor(w.user.id, { bookingId: b.id, type: 'PAYMENT_HELD' }))[0].title, 'Booking payment confirmed');

  assert.equal((await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: c.token })).status, 200);
  const wt = (await notesFor(w.user.id, { bookingId: b.id })).map((n) => n.type);
  assert.ok(wt.includes('JOB_COMPLETED') && wt.includes('EARNINGS_UPDATED'), wt.join());
  assert.equal((await notesFor(w.user.id, { type: 'EARNINGS_UPDATED' }))[0].category, 'EARNINGS');

  const p = await prisma.payment.findUnique({ where: { bookingId: b.id } });
  const ref = await api('POST', `/api/admin/payments/${p.id}/refund`, { token: admin.token, json: { amount: 100, reason: 'Goodwill' } });
  assert.equal(ref.status, 200, JSON.stringify(ref.data));
  assert.equal((await notesFor(c.user.id, { bookingId: b.id, type: 'REFUND_PROCESSED' })).length, 1);
  assert.equal((await notesFor(w.user.id, { bookingId: b.id, type: 'EARNINGS_UPDATED' })).length, 2, 'earnings change again after the refund');

  // dispute: both parties hear about it, then about the outcome
  const b2 = await makeBooking(c, w, 'IN_PROGRESS');
  const o2 = await api('POST', `/api/payments/booking/${b2.id}/order`, { token: c.token });
  const e2 = gw.pay(o2.data.orderId);
  await api('POST', `/api/payments/booking/${b2.id}/verify`, { token: c.token, json: { razorpay_order_id: o2.data.orderId, razorpay_payment_id: e2.id, razorpay_signature: checkoutSignature(process.env.RAZORPAY_KEY_SECRET, o2.data.orderId, e2.id) } });
  assert.equal((await api('POST', `/api/payments/booking/${b2.id}/dispute`, { token: c.token, json: { reason: 'The work was not finished' } })).status, 200);
  assert.equal((await notesFor(w.user.id, { bookingId: b2.id, type: 'DISPUTE_UPDATE' })).length, 1);
  assert.equal((await notesFor(c.user.id, { bookingId: b2.id, type: 'DISPUTE_UPDATE' })).length, 1);
  const p2 = await prisma.payment.findUnique({ where: { bookingId: b2.id } });
  assert.equal((await api('POST', `/api/admin/payments/${p2.id}/resolve-dispute`, { token: admin.token, json: { decision: 'RELEASE_TO_WORKER', reason: 'Work verified complete' } })).status, 200);
  assert.equal((await notesFor(w.user.id, { bookingId: b2.id, type: 'DISPUTE_UPDATE' })).length, 2);
  assert.equal((await notesFor(c.user.id, { bookingId: b2.id, type: 'DISPUTE_UPDATE' })).length, 2);
  assert.equal(await prisma.notification.count({ where: { userId: admin.user.id } }), 0, 'admins are not spammed with customer events');
});

test('payout status changes notify the worker (settled; failed attempt)', async () => {
  process.env.PAYOUT_MODE = 'ROUTE';
  const route = new FakeRoute(); routeClient.setHttpClient(route.client());
  try {
    const c = await makeUser('po-c', 'CUSTOMER'); const w = await makeWorker('po-w');
    await prisma.workerPayoutAccount.create({ data: { userId: w.user.id, status: 'ACTIVATED', gatewayAccountId: 'acc_po', gatewayProductId: 'prd', legalName: 'T', bankLast4: '1234' } });
    const b = await makeBooking(c, w, 'IN_PROGRESS');
    const o = await api('POST', `/api/payments/booking/${b.id}/order`, { token: c.token });
    const ent = gw.pay(o.data.orderId);
    await api('POST', `/api/payments/booking/${b.id}/verify`, { token: c.token, json: { razorpay_order_id: o.data.orderId, razorpay_payment_id: ent.id, razorpay_signature: checkoutSignature(process.env.RAZORPAY_KEY_SECRET, o.data.orderId, ent.id) } });
    await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: c.token });
    const s = await prisma.workerSettlement.findFirst({ where: { bookingId: b.id } });
    const hook = (event, entity) => { const body = JSON.stringify({ event, payload: { transfer: { entity } } }); return api('POST', '/api/payments/webhook', { raw: body, headers: { 'x-razorpay-signature': webhookSignature(process.env.RAZORPAY_WEBHOOK_SECRET, body), 'x-razorpay-event-id': `evt_${tag}_${event}_${Math.random()}` } }); };
    await hook('transfer.processed', { id: s.gatewayTransferId, status: 'processed', settlement_status: 'settled' });
    const settled = (await notesFor(w.user.id, { type: 'PAYOUT_UPDATE' }))[0];
    assert.equal(settled.title, 'Payout settled'); assert.equal(settled.bookingId, b.id); assert.equal(settled.category, 'EARNINGS');

    // a payout attempt that fails at the provider is reported too
    const b2 = await makeBooking(c, w, 'IN_PROGRESS');
    const o2 = await api('POST', `/api/payments/booking/${b2.id}/order`, { token: c.token });
    const e2 = gw.pay(o2.data.orderId);
    await api('POST', `/api/payments/booking/${b2.id}/verify`, { token: c.token, json: { razorpay_order_id: o2.data.orderId, razorpay_payment_id: e2.id, razorpay_signature: checkoutSignature(process.env.RAZORPAY_KEY_SECRET, o2.data.orderId, e2.id) } });
    route.failHold = true; // releasing the held transfer fails at the provider
    await api('POST', `/api/payments/booking/${b2.id}/confirm-completion`, { token: c.token });
    const failed = (await notesFor(w.user.id, { type: 'PAYOUT_UPDATE', bookingId: b2.id }))[0];
    assert.equal(failed.title, 'Payout problem');
    assert.equal((await prisma.workerSettlement.findFirst({ where: { bookingId: b2.id } })).status, 'FAILED');
  } finally { delete process.env.PAYOUT_MODE; routeClient.setHttpClient(null); }
});

// ─── Real-time delivery ─────────────────────────────────────────────────────

test('notifications are pushed live over Socket.IO to the right user only, with the unread count', async () => {
  const c = await makeUser('lv-c', 'CUSTOMER'); const w = await makeWorker('lv-w'); const bystander = await makeUser('lv-x', 'CUSTOMER');
  const ws = connect(w.token); const cs = connect(c.token); const xs = connect(bystander.token);
  await Promise.all([ws.ready(), cs.ready(), xs.ready()]);
  await api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: future(), timeSlot: 'x', agreedPrice: 500, problemDescription: 'Fix the sink' } });
  const live = await ws.when('notification:new');
  assert.equal(live.notification.type, 'BOOKING_REQUEST');
  assert.match(live.notification.message, /Fix the sink/);
  assert.equal(live.unreadCount, 1);
  const own = await cs.when('notification:new');
  assert.equal(own.notification.title, 'Booking request submitted');
  await settle(200);
  assert.equal(xs.received.filter((r) => r.event === 'notification:new').length, 0, 'someone else never receives it');
  // marking read pushes the new unread count to the user's other tabs
  await api('PATCH', `/api/notifications/${live.notification.id}/read`, { token: w.token });
  const unread = await ws.when('notification:unread', (e) => e.unreadCount === 0);
  assert.equal(unread.unreadCount, 0);
});

// ─── Notification centre API ────────────────────────────────────────────────

test('notification centre: lists, filters, paginates, marks read, marks all read, and stays private', async () => {
  const c = await makeUser('nc-c', 'CUSTOMER'); const other = await makeUser('nc-o', 'CUSTOMER');
  assert.deepEqual((await api('GET', '/api/notifications', { token: c.token })).data.notifications, [], 'a new account has no notifications (nothing is fabricated)');
  assert.equal((await api('GET', '/api/notifications/unread-count', { token: c.token })).data.unreadCount, 0);
  const b = await makeBooking(c, await makeWorker('nc-w'));
  const mk = (type, title, ageMs, data = {}) => prisma.notification.create({ data: { userId: c.user.id, type, title, message: `${title} message`, category: require('../services/notificationService').categoryFor(type), bookingId: b.id, createdAt: new Date(Date.now() - ageMs), ...data } });
  const n1 = await mk('BOOKING_CONFIRMED', 'Accepted', 50000);
  const n2 = await mk('PAYMENT_HELD', 'Paid', 40000);
  const n3 = await mk('NEW_MESSAGE', 'Message', 30000);
  const n4 = await mk('REFUND_PROCESSED', 'Refund', 20000);
  const n5 = await mk('DISPUTE_UPDATE', 'Dispute', 10000, { isRead: true, readAt: new Date() });
  await prisma.notification.create({ data: { userId: other.user.id, type: 'SYSTEM_ALERT', title: 'Not yours', message: 'private', category: 'SYSTEM' } });

  const all = await api('GET', '/api/notifications', { token: c.token });
  assert.deepEqual(all.data.notifications.map((n) => n.title), ['Dispute', 'Refund', 'Message', 'Paid', 'Accepted'], 'newest first');
  assert.equal(all.data.unreadCount, 4);
  assert.ok(all.data.notifications.every((n) => n.createdAt && n.category && typeof n.isRead === 'boolean' && n.bookingId === b.id));
  assert.equal(JSON.stringify(all.data).includes('Not yours'), false);
  assert.deepEqual((await api('GET', '/api/notifications?category=PAYMENT', { token: c.token })).data.notifications.map((n) => n.title).sort(), ['Paid', 'Refund']);
  assert.deepEqual((await api('GET', '/api/notifications?category=message', { token: c.token })).data.notifications.map((n) => n.title), ['Message']);
  assert.equal((await api('GET', '/api/notifications?unread=true', { token: c.token })).data.notifications.length, 4);
  const p1 = await api('GET', '/api/notifications?limit=2', { token: c.token });
  assert.deepEqual(p1.data.notifications.map((n) => n.title), ['Dispute', 'Refund']);
  assert.equal(p1.data.hasMore, true);
  const p2 = await api('GET', `/api/notifications?limit=10&before=${encodeURIComponent(p1.data.notifications[1].createdAt)}`, { token: c.token });
  assert.deepEqual(p2.data.notifications.map((n) => n.title), ['Message', 'Paid', 'Accepted']);
  assert.equal(p2.data.hasMore, false);

  // mark one read; someone else's id is untouched
  const r = await api('PATCH', `/api/notifications/${n1.id}/read`, { token: c.token });
  assert.equal(r.data.updated, true); assert.equal(r.data.unreadCount, 3);
  assert.ok((await prisma.notification.findUnique({ where: { id: n1.id } })).readAt);
  const foreign = await prisma.notification.findFirst({ where: { userId: other.user.id } });
  const steal = await api('PATCH', `/api/notifications/${foreign.id}/read`, { token: c.token });
  assert.equal(steal.data.updated, false);
  assert.equal((await prisma.notification.findUnique({ where: { id: foreign.id } })).isRead, false);
  assert.equal((await api('PATCH', `/api/notifications/${n1.id}/read`, { token: c.token })).data.updated, false, 'already read');

  // mark all read, only a category first
  const cat = await api('POST', '/api/notifications/read-all', { token: c.token, json: { category: 'PAYMENT' } });
  assert.equal(cat.data.updated, 2); assert.equal(cat.data.unreadCount, 1);
  const allr = await api('POST', '/api/notifications/read-all', { token: c.token });
  assert.equal(allr.data.updated, 1); assert.equal(allr.data.unreadCount, 0);
  assert.equal((await prisma.notification.findFirst({ where: { userId: other.user.id } })).isRead, false, "other users' notifications untouched");
  assert.equal((await api('GET', '/api/notifications')).status, 401);
  assert.equal(n2.id && n3.id && n4.id && n5.id ? true : false, true);
});

// ─── Web Push ───────────────────────────────────────────────────────────────

const validSub = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${n}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } });
const enablePush = () => { process.env.VAPID_PUBLIC_KEY = 'BPublicKeyForTestsOnly_notASecret'; process.env.VAPID_PRIVATE_KEY = 'private_key_for_tests_must_never_appear_in_any_response'; process.env.VAPID_SUBJECT = 'mailto:ops@example.com'; };

test('push is honestly unavailable until VAPID keys are configured', async () => {
  const u = await makeUser('pu-u', 'CUSTOMER');
  const cfg = await api('GET', '/api/push/config');
  assert.equal(cfg.status, 200); assert.equal(cfg.data.supported, false); assert.equal(cfg.data.publicKey, null);
  const sub = await api('POST', '/api/push/subscribe', { token: u.token, json: { subscription: validSub() } });
  assert.equal(sub.status, 503); assert.equal(sub.data.code, 'PUSH_NOT_CONFIGURED');
  assert.equal(await prisma.pushSubscription.count({ where: { userId: u.user.id } }), 0);
  assert.equal((await api('GET', '/api/push/status', { token: u.token })).data.configured, false);
  // sending without configuration does nothing and does not throw
  const out = await push.sendToUser(u.user.id, { title: 't', body: 'b' });
  assert.deepEqual(out, { configured: false, attempted: 0, sent: 0, expired: 0, failed: 0 });
});

test('push subscription: validation, subscribe, idempotent re-subscribe, move between accounts, unsubscribe; no private key ever leaves the server', async () => {
  enablePush();
  const a = await makeUser('ps-a', 'CUSTOMER'); const b = await makeUser('ps-b', 'WORKER');
  const cfg = await api('GET', '/api/push/config');
  assert.equal(cfg.data.supported, true); assert.equal(cfg.data.publicKey, process.env.VAPID_PUBLIC_KEY);

  assert.equal((await api('POST', '/api/push/subscribe', { json: { subscription: validSub() } })).status, 401);
  const bad = (subscription) => api('POST', '/api/push/subscribe', { token: a.token, json: { subscription } });
  assert.equal((await bad(null)).status, 400);
  assert.equal((await bad({ endpoint: 'http://insecure.example/push', keys: validSub().keys })).status, 400, 'https only');
  assert.equal((await bad({ endpoint: 'not a url', keys: validSub().keys })).status, 400);
  assert.equal((await bad({ endpoint: validSub().endpoint })).status, 400, 'keys required');
  assert.equal((await bad({ endpoint: validSub().endpoint, keys: { p256dh: '<script>', auth: 'x' } })).status, 400);
  assert.equal((await bad({ endpoint: `https://x.example/${'a'.repeat(2100)}`, keys: validSub().keys })).status, 400);
  assert.equal(await prisma.pushSubscription.count({ where: { userId: a.user.id } }), 0);

  const sub = validSub(1);
  assert.equal((await bad(sub)).status, 201);
  assert.equal((await bad(sub)).status, 201);
  assert.equal(await prisma.pushSubscription.count({ where: { endpoint: sub.endpoint } }), 1, 'same browser, one row');
  assert.equal((await api('GET', '/api/push/status', { token: a.token })).data.subscriptions, 1);
  assert.equal((await api('POST', '/api/push/subscribe', { token: b.token, json: { subscription: sub } })).status, 201);
  assert.equal((await prisma.pushSubscription.findUnique({ where: { endpoint: sub.endpoint } })).userId, b.user.id, 'a shared browser follows the account that is logged in now');
  assert.equal((await api('GET', '/api/push/status', { token: a.token })).data.subscriptions, 0);

  // only the owner can remove a subscription
  assert.equal((await api('POST', '/api/push/unsubscribe', { token: a.token, json: { endpoint: sub.endpoint } })).data.removed, 0);
  assert.equal(await prisma.pushSubscription.count({ where: { endpoint: sub.endpoint } }), 1);
  assert.equal((await api('POST', '/api/push/unsubscribe', { token: b.token, json: { endpoint: sub.endpoint } })).data.removed, 1);
  assert.equal(await prisma.pushSubscription.count({ where: { endpoint: sub.endpoint } }), 0);

  const everything = JSON.stringify([cfg.data, (await api('GET', '/api/push/status', { token: a.token })).data, (await bad(validSub(2))).data]);
  assert.equal(everything.includes(process.env.VAPID_PRIVATE_KEY), false, 'the private key is never returned');
});

test('push delivery: notifications are sent to every subscribed device with a safe, bounded payload; none for users without subscriptions', async () => {
  enablePush();
  const c = await makeUser('pd-c', 'CUSTOMER'); const w = await makeWorker('pd-w');
  const calls = [];
  push.setSender(async (subscription, payload, options) => { calls.push({ subscription, payload: JSON.parse(payload), options }); return { statusCode: 201 }; });
  await push.subscribe(w.user.id, validSub(10), 'UA/1'); await push.subscribe(w.user.id, validSub(11), 'UA/2');

  const r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: future(), timeSlot: 'x', agreedPrice: 500, problemDescription: 'Fix the sink. '.repeat(40).slice(0, 600) } });
  assert.equal(r.status, 201);
  await settle(300);
  assert.equal(calls.length, 2, 'both of the worker\'s devices');
  assert.deepEqual(new Set(calls.map((x) => x.subscription.endpoint)), new Set([validSub(10).endpoint, validSub(11).endpoint]));
  const sent = calls[0].payload;
  assert.equal(sent.title, 'New booking request');
  assert.equal(sent.bookingId, r.data.booking.id);
  assert.equal(sent.url, `/pages/my-jobs.html?booking=${r.data.booking.id}`);
  assert.ok(sent.body.length <= 160);
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) < 3000);
  assert.equal(JSON.stringify(calls).includes(process.env.VAPID_PRIVATE_KEY), false, 'the private key is not in anything handed to the push transport');
  assert.equal(calls.filter((x) => x.subscription.endpoint.includes('customer')).length, 0);
  // the customer has no subscription: their "request submitted" notification produced no push
  const row = await prisma.pushSubscription.findUnique({ where: { endpoint: validSub(10).endpoint } });
  assert.ok(row.lastSuccessAt);
  assert.equal(row.failureCount, 0);

  // chat message: pushed to the recipient only when they are not looking at that chat
  const b = await makeBooking(c, w);
  calls.length = 0;
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'Are you on your way?', clientMessageId: `m${tag}aaaa1` } });
  await settle(300);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.url, `/pages/chat.html?booking=${b.id}`);
  assert.match(calls[0].payload.title, /New message from/);
  calls.length = 0;
  const ws = connect(w.token); await ws.ready();
  await new Promise((resolve) => ws.socket.timeout(2000).emit('chat:join', { bookingId: b.id }, resolve));
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'Still there?', clientMessageId: `m${tag}aaaa2` } });
  await settle(300);
  assert.equal(calls.length, 0, 'no push while the recipient has the chat open');
});

test('expired and failing push subscriptions are cleaned up; one bad device does not block the others', async () => {
  enablePush();
  const u = await makeUser('px-u', 'CUSTOMER');
  const outcomes = { [validSub(20).endpoint]: { statusCode: 410 }, [validSub(21).endpoint]: { statusCode: 404 }, [validSub(22).endpoint]: { statusCode: 500 }, [validSub(23).endpoint]: null };
  const attempts = [];
  push.setSender(async (s) => { attempts.push(s.endpoint); const o = outcomes[s.endpoint]; if (o) { const e = new Error('push service error'); e.statusCode = o.statusCode; throw e; } return { statusCode: 201 }; });
  for (const n of [20, 21, 22, 23]) await push.subscribe(u.user.id, validSub(n), 'UA');

  const r1 = await push.sendToUser(u.user.id, { title: 'Hi', body: 'There' });
  assert.deepEqual({ attempted: r1.attempted, sent: r1.sent, expired: r1.expired, failed: r1.failed }, { attempted: 4, sent: 1, expired: 2, failed: 1 });
  const left = await prisma.pushSubscription.findMany({ where: { userId: u.user.id } });
  assert.deepEqual(left.map((s) => s.endpoint).sort(), [validSub(22).endpoint, validSub(23).endpoint].sort(), '410 and 404 subscriptions were deleted');
  const flaky = left.find((s) => s.endpoint === validSub(22).endpoint);
  assert.equal(flaky.failureCount, 1); assert.ok(flaky.lastFailureAt);
  const good = left.find((s) => s.endpoint === validSub(23).endpoint);
  assert.ok(good.lastSuccessAt);

  // a transient failure is retried on later notifications and dropped after repeated failures
  for (let i = 0; i < push.MAX_FAILURES - 1; i += 1) await push.sendToUser(u.user.id, { title: 'again', body: 'x' });
  assert.equal(await prisma.pushSubscription.count({ where: { endpoint: validSub(22).endpoint } }), 0, 'removed after repeated failures');
  assert.equal(await prisma.pushSubscription.count({ where: { endpoint: validSub(23).endpoint } }), 1, 'healthy subscription kept');

  // a push-service failure never breaks the request that created the notification
  push.setSender(async () => { throw new Error('network down'); });
  const w = await makeWorker('px-w'); await push.subscribe(w.user.id, validSub(30), 'UA');
  const c = await makeUser('px-c', 'CUSTOMER');
  assert.equal((await api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: future(), timeSlot: 'x', agreedPrice: 500, problemDescription: 'Still works' } })).status, 201);
  assert.equal((await notesFor(w.user.id)).length, 1, 'the in-app notification is stored regardless');
});
