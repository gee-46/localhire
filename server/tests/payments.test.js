// Payments, refunds, settlements and earnings.
//
// Real Express routes, real PostgreSQL, real HMAC signatures (checkout + webhook). Only the Razorpay network
// is replaced by an in-memory fake (tests/helpers/fakeRazorpay.js), so no real money or Razorpay account is used.
// This proves LocalHire's own logic; it does not prove behaviour of the live Razorpay service.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_localtest0001';
process.env.RAZORPAY_KEY_SECRET = 'local_test_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'local_test_webhook_secret';
process.env.PLATFORM_FEE_PERCENT = '5';
process.env.PLATFORM_FEE_TAX_PERCENT = '18';
process.env.WORKER_COMMISSION_PERCENT = '10';
process.env.CUSTOMER_CANCELLATION_FEE_PERCENT = '10';
process.env.PAYMENT_RATE_LIMIT_MAX = '10000';
delete process.env.PAYOUT_MODE;

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { setRazorpayInstance } = require('../config/razorpay');
const routeClient = require('../services/routeClient');
const settlementService = require('../services/settlementService');
const { server } = require('../server');
const { FakeRazorpay, FakeRoute, checkoutSignature, webhookSignature } = require('./helpers/fakeRazorpay');

const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WH_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const tag = `pay${Date.now()}`;
const users = [];
let base;
let plumber;
let seq = 0;
const gw = new FakeRazorpay();
const route = new FakeRoute();

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

async function makeUser(label, role, extra = {}) {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210', ...extra } });
  users.push(user.id);
  return { user, token: signSessionToken(user) };
}

async function makeWorker(label, verificationStatus = 'VERIFIED') {
  const w = await makeUser(label, 'WORKER');
  const profile = await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus, hourlyRate: 300, bio: 'Plumber', reviewsCount: 0, rating: 0 } });
  await prisma.workerLocation.create({ data: { workerProfileId: profile.id, latitude: 15.85, longitude: 74.51, lastLocationUpdate: new Date(), isAvailable: true, sharingEnabled: true } });
  return { ...w, profile };
}

async function makeBooking({ customer, worker, status = 'CONFIRMED', price = 1000, priceConfirmed = true, description = 'Leaking kitchen tap' }) {
  return prisma.booking.create({
    data: {
      bookingNumber: `BK-${tag}-${++seq}`, customerId: customer.user.id, workerId: worker.user.id, status, agreedPrice: price,
      scheduledAt: new Date(Date.now() + 86400000), timeSlot: '10:00 - 12:00', problemDescription: description,
      priceConfirmedAt: priceConfirmed ? new Date() : null
    }
  });
}

const orderFor = (token, bookingId) => api('POST', `/api/payments/booking/${bookingId}/order`, { token, json: { amount: 1 } });
const verifyFor = (token, bookingId, orderId, paymentId, signature) =>
  api('POST', `/api/payments/booking/${bookingId}/verify`, { token, json: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature ?? checkoutSignature(KEY_SECRET, orderId, paymentId) } });

// Create an order, "pay" it at the fake gateway and run the Checkout callback.
async function payFully(customer, booking, { method = 'card' } = {}) {
  const o = await orderFor(customer.token, booking.id);
  assert.equal(o.status === 201 || o.status === 200, true, JSON.stringify(o.data));
  const ent = gw.pay(o.data.orderId, { status: 'captured', method });
  const v = await verifyFor(customer.token, booking.id, o.data.orderId, ent.id);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return { order: o.data, entity: ent, verify: v.data };
}

let eventSeq = 0;
function webhook(event, entity, { eventId, secret = WH_SECRET, sign = true, extra = {} } = {}) {
  const payloadKey = event.startsWith('refund') ? 'refund' : event.startsWith('transfer') ? 'transfer' : 'payment';
  const body = JSON.stringify({ entity: 'event', event, payload: { [payloadKey]: { entity }, ...extra } });
  const headers = { 'x-razorpay-event-id': eventId || `evt_${tag}_${++eventSeq}` };
  if (sign) headers['x-razorpay-signature'] = webhookSignature(secret, body);
  return api('POST', '/api/payments/webhook', { raw: body, headers });
}

const payment = (bookingId) => prisma.payment.findUnique({ where: { bookingId }, include: { settlement: true, refunds: true, transactions: true } });
const money = (n) => Number(n);

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  assert.ok(plumber, 'migrations must have been applied');
  setRazorpayInstance(gw);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(() => { gw.reset(); route.reset(); process.env.PAYOUT_MODE = 'LEDGER_ONLY'; routeClient.setHttpClient(null); });

test.after(async () => {
  const q = { where: { OR: [{ customerId: { in: users } }, { workerId: { in: users } }] } };
  const payIds = (await prisma.payment.findMany({ ...q, select: { id: true } })).map((p) => p.id);
  const bookingIds = (await prisma.booking.findMany({ ...q, select: { id: true } })).map((b) => b.id);
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
  await prisma.workerSettlement.deleteMany({ where: { paymentId: { in: payIds } } }).catch(() => {});
  await prisma.payment.deleteMany({ where: { id: { in: payIds } } }).catch(() => {});
  await prisma.supportTicket.deleteMany({ where: { bookingId: { in: bookingIds } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: users } }, { entityId: { in: payIds } }] } }).catch(() => {});
  await prisma.workerPayoutAccount.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookingIds } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } }).catch(() => {});
  await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: `evt_${tag}` } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  setRazorpayInstance(null);
  routeClient.setHttpClient(null);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ─── Configuration ──────────────────────────────────────────────────────────

test('public config exposes only the public key id, never a secret', async () => {
  const r = await api('GET', '/api/payments/config');
  assert.equal(r.status, 200);
  assert.equal(r.data.keyId, 'rzp_test_localtest0001');
  assert.equal(r.data.mode, 'test');
  const text = JSON.stringify(r.data);
  assert.equal(text.includes(KEY_SECRET), false);
  assert.equal(text.includes(WH_SECRET), false);
});

// ─── Server-side amounts and eligibility ────────────────────────────────────

test('amounts are computed on the server: service, platform fee, tax and total; client amount is ignored', async () => {
  const c = await makeUser('amt-c', 'CUSTOMER');
  const w = await makeWorker('amt-w');
  const b = await makeBooking({ customer: c, worker: w, price: 1000 });

  const q = await api('GET', `/api/payments/booking/${b.id}/quote`, { token: c.token });
  assert.equal(q.status, 200);
  assert.deepEqual([q.data.breakdown.serviceAmount, q.data.breakdown.platformFee, q.data.breakdown.taxAmount, q.data.breakdown.totalAmount], [1000, 50, 9, 1059]);
  assert.equal(q.data.booking.worker.name, w.user.name);
  assert.equal(q.data.payable.ok, true);

  const o = await orderFor(c.token, b.id); // body tries to say amount: 1
  assert.equal(o.status, 201);
  assert.equal(o.data.amount, 105900, 'order amount in paise comes from the booking price, not the request');
  assert.equal(gw.orderStore.get(o.data.orderId).amount, 105900);
  assert.equal(o.data.keyId, 'rzp_test_localtest0001');
  assert.equal(JSON.stringify(o.data).includes(KEY_SECRET), false);
  const p = await payment(b.id);
  assert.equal(p.state, 'CREATED');
  assert.deepEqual([money(p.serviceAmount), money(p.platformFee), money(p.taxAmount), money(p.totalAmount)], [1000, 50, 9, 1059]);
});

test('payment is refused before the worker accepts and confirms the price, and for the wrong people', async () => {
  const c = await makeUser('gate-c', 'CUSTOMER');
  const other = await makeUser('gate-o', 'CUSTOMER');
  const w = await makeWorker('gate-w');

  const requested = await makeBooking({ customer: c, worker: w, status: 'REQUESTED', priceConfirmed: false });
  let r = await orderFor(c.token, requested.id);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'AWAITING_WORKER');

  const unconfirmed = await makeBooking({ customer: c, worker: w, status: 'CONFIRMED', priceConfirmed: false });
  r = await orderFor(c.token, unconfirmed.id);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'PRICE_NOT_CONFIRMED');

  const cancelled = await makeBooking({ customer: c, worker: w, status: 'CANCELLED' });
  r = await orderFor(c.token, cancelled.id);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'BAD_BOOKING_STATUS');

  const ok = await makeBooking({ customer: c, worker: w });
  assert.equal((await orderFor(other.token, ok.id)).status, 403, 'another customer cannot pay for it');
  assert.equal((await orderFor(w.token, ok.id)).status, 403, 'the worker cannot create a customer payment');
  assert.equal((await api('POST', `/api/payments/booking/${ok.id}/order`)).status, 401);
  assert.equal((await orderFor(c.token, 'does-not-exist')).status, 404);
  assert.equal(gw.count('orders.create'), 0, 'no gateway order was created for any refused request');
  assert.equal(await prisma.payment.count({ where: { bookingId: { in: [requested.id, unconfirmed.id, cancelled.id, ok.id] } } }), 0);
});

// ─── Successful payment ─────────────────────────────────────────────────────

test('successful payment: verified server-side, CAPTURED, settlement created, booking state untouched', async () => {
  const c = await makeUser('ok-c', 'CUSTOMER');
  const w = await makeWorker('ok-w');
  const b = await makeBooking({ customer: c, worker: w, price: 1000 });

  const { verify, entity } = await payFully(c, b, { method: 'card' });
  assert.equal(verify.confirmed, true);
  assert.equal(verify.payment.state, 'CAPTURED');

  const p = await payment(b.id);
  assert.equal(p.state, 'CAPTURED');
  assert.equal(p.gatewayPaymentId, entity.id);
  assert.equal(p.method, 'card');
  assert.match(p.methodDetail, /Visa/);
  assert.ok(p.capturedAt);
  assert.equal(p.settlement.status, 'PENDING_COMPLETION');
  assert.deepEqual([money(p.settlement.serviceAmount), money(p.settlement.commission), money(p.settlement.netAmount)], [1000, 100, 900]);
  assert.deepEqual(p.transactions.map((t) => t.type).sort(), ['CAPTURED', 'ORDER_CREATED']);
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'CONFIRMED', 'payment and booking states are independent');
  assert.ok(await prisma.notification.findFirst({ where: { userId: w.user.id, type: 'PAYMENT_HELD' } }), 'worker is told the customer paid');

  // repeating the callback is harmless
  const again = await verifyFor(c.token, b.id, p.gatewayOrderId, entity.id);
  assert.equal(again.status, 200);
  assert.equal(await prisma.paymentTransaction.count({ where: { paymentId: p.id, type: 'CAPTURED' } }), 1);
  assert.equal(await prisma.workerSettlement.count({ where: { paymentId: p.id } }), 1);
});

test('an authorized payment (manual capture account) is captured by the server for the exact order amount', async () => {
  const c = await makeUser('auth-c', 'CUSTOMER');
  const w = await makeWorker('auth-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const ent = gw.pay(o.data.orderId, { status: 'authorized', method: 'upi' });
  const v = await verifyFor(c.token, b.id, o.data.orderId, ent.id);
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(gw.count('payments.capture'), 1);
  assert.equal(gw.calls.find((x) => x[0] === 'payments.capture')[2], 105900);
  const p = await payment(b.id);
  assert.equal(p.state, 'CAPTURED');
  assert.ok(p.authorizedAt);
  assert.ok(p.transactions.some((t) => t.type === 'AUTHORIZED'));
});

// ─── Never trust the frontend ───────────────────────────────────────────────

test('invalid checkout signature is rejected and nothing is marked paid', async () => {
  const c = await makeUser('sig-c', 'CUSTOMER');
  const w = await makeWorker('sig-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const ent = gw.pay(o.data.orderId);

  let r = await verifyFor(c.token, b.id, o.data.orderId, ent.id, 'deadbeef'.repeat(8));
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'INVALID_SIGNATURE');
  // signature computed for a different order id
  r = await verifyFor(c.token, b.id, o.data.orderId, ent.id, checkoutSignature(KEY_SECRET, 'order_other', ent.id));
  assert.equal(r.status, 400);
  // signed with the wrong secret
  r = await verifyFor(c.token, b.id, o.data.orderId, ent.id, checkoutSignature('not_the_secret', o.data.orderId, ent.id));
  assert.equal(r.status, 400);
  // missing signature
  r = await api('POST', `/api/payments/booking/${b.id}/verify`, { token: c.token, json: { razorpay_payment_id: ent.id } });
  assert.equal(r.status, 400);
  // an order id from the browser that is not this booking's order
  r = await verifyFor(c.token, b.id, 'order_forged', ent.id);
  assert.equal(r.status, 400);

  const p = await payment(b.id);
  assert.equal(p.state, 'CREATED');
  assert.equal(p.settlement, null);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_SIGNATURE_REJECTED', entityId: p.id } }), 'rejections are audit logged');
});

test('a valid signature alone is not enough: the server confirms with Razorpay, and amount must match', async () => {
  const c = await makeUser('srv-c', 'CUSTOMER');
  const w = await makeWorker('srv-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);

  // payment id the gateway has never heard of, with a (somehow) valid signature -> not paid
  let r = await verifyFor(c.token, b.id, o.data.orderId, 'pay_unknown');
  assert.equal(r.status, 202);
  assert.equal(r.data.pending, true);
  assert.equal((await payment(b.id)).state, 'CREATED');

  // gateway unreachable -> pending, not paid
  const real = gw.pay(o.data.orderId);
  gw.failFetch = true;
  r = await verifyFor(c.token, b.id, o.data.orderId, real.id);
  assert.equal(r.status, 202);
  assert.equal((await payment(b.id)).state, 'CREATED');
  gw.failFetch = false;

  // customer paid the wrong amount at the gateway
  const b2 = await makeBooking({ customer: c, worker: w });
  const o2 = await orderFor(c.token, b2.id);
  const short = gw.pay(o2.data.orderId, { amount: 100 });
  r = await verifyFor(c.token, b2.id, o2.data.orderId, short.id);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'AMOUNT_MISMATCH');
  assert.equal((await payment(b2.id)).state, 'CREATED');
});

test("someone else's payment cannot be verified, synced, viewed or confirmed", async () => {
  const c = await makeUser('own-c', 'CUSTOMER');
  const thief = await makeUser('own-t', 'CUSTOMER');
  const w = await makeWorker('own-w');
  const b = await makeBooking({ customer: c, worker: w });
  const { order, entity } = await payFully(c, b);
  const p = await payment(b.id);
  assert.equal((await verifyFor(thief.token, b.id, order.orderId, entity.id)).status, 403);
  assert.equal((await api('POST', `/api/payments/booking/${b.id}/sync`, { token: thief.token })).status, 403);
  assert.equal((await api('GET', `/api/payments/${p.id}`, { token: thief.token })).status, 404);
  assert.equal((await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: thief.token })).status, 403);
  assert.equal((await api('GET', `/api/payments/${p.id}`, { token: w.token })).status, 403, 'workers have no customer payment view');
  assert.equal((await api('GET', '/api/payments/history', { token: w.token })).status, 403);
});

// ─── Failed payment ─────────────────────────────────────────────────────────

test('failed payment is recorded as FAILED, the booking stays unpaid, and the customer can retry on a new order', async () => {
  const c = await makeUser('fail-c', 'CUSTOMER');
  const w = await makeWorker('fail-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o1 = await orderFor(c.token, b.id);
  gw.pay(o1.data.orderId, { status: 'failed' });

  const s = await api('POST', `/api/payments/booking/${b.id}/sync`, { token: c.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.payment.state, 'FAILED');
  assert.match(s.data.payment.failureReason, /declined/);
  let p = await payment(b.id);
  assert.equal(p.state, 'FAILED');
  assert.equal(p.settlement, null, 'no settlement exists for an unpaid booking');
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'CONFIRMED');

  const o2 = await orderFor(c.token, b.id);
  assert.notEqual(o2.data.orderId, o1.data.orderId, 'a retry uses a fresh order');
  const ent = gw.pay(o2.data.orderId);
  assert.equal((await verifyFor(c.token, b.id, o2.data.orderId, ent.id)).status, 200);
  p = await payment(b.id);
  assert.equal(p.state, 'CAPTURED');
  assert.equal(p.attempts, 2);
  assert.equal(p.failureReason, null);
  assert.equal(await prisma.payment.count({ where: { bookingId: b.id } }), 1, 'still one payment row per booking');
});

test('payment.failed webhook marks the attempt FAILED', async () => {
  const c = await makeUser('wf-c', 'CUSTOMER');
  const w = await makeWorker('wf-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const ent = gw.pay(o.data.orderId, { status: 'failed' });
  const r = await webhook('payment.failed', ent);
  assert.equal(r.status, 200);
  assert.equal((await payment(b.id)).state, 'FAILED');
});

// ─── Webhooks ───────────────────────────────────────────────────────────────

test('webhook signature is verified against the raw body', async () => {
  const c = await makeUser('wh-c', 'CUSTOMER');
  const w = await makeWorker('wh-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const ent = gw.pay(o.data.orderId);

  let r = await webhook('payment.captured', ent, { sign: false });
  assert.equal(r.status, 400, 'missing signature');
  r = await webhook('payment.captured', ent, { secret: 'wrong_secret' });
  assert.equal(r.status, 400, 'wrong signature');
  // valid signature for a different body than the one sent
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: ent } } });
  r = await api('POST', '/api/payments/webhook', { raw: body.replace('captured', 'captureX'), headers: { 'x-razorpay-signature': webhookSignature(WH_SECRET, body), 'x-razorpay-event-id': `evt_${tag}_tamper` } });
  assert.equal(r.status, 400, 'tampered body');
  assert.equal((await payment(b.id)).state, 'CREATED', 'rejected webhooks change nothing');
  assert.equal(await prisma.webhookEvent.count({ where: { eventId: { startsWith: `evt_${tag}_tamper` } } }), 0);

  r = await webhook('payment.captured', ent);
  assert.equal(r.status, 200);
  const p = await payment(b.id);
  assert.equal(p.state, 'CAPTURED', 'a signed webhook can settle a payment even if the browser never came back');
  assert.equal(p.settlement.status, 'PENDING_COMPLETION');
});

test('duplicate webhook delivery is processed exactly once', async () => {
  const c = await makeUser('dw-c', 'CUSTOMER');
  const w = await makeWorker('dw-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const ent = gw.pay(o.data.orderId);
  const eventId = `evt_${tag}_dup`;
  const first = await webhook('payment.captured', ent, { eventId });
  const second = await webhook('payment.captured', ent, { eventId });
  const third = await webhook('payment.captured', ent, { eventId });
  assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
  assert.equal(first.data.result, 'PROCESSED');
  assert.equal(second.data.result, 'DUPLICATE');
  assert.equal(third.data.result, 'DUPLICATE');
  const p = await payment(b.id);
  assert.equal(p.transactions.filter((t) => t.type === 'CAPTURED').length, 1);
  assert.equal(await prisma.workerSettlement.count({ where: { paymentId: p.id } }), 1);
  assert.equal(await prisma.webhookEvent.count({ where: { eventId } }), 1);

  // the same payment arriving as a *different* event (order.paid after payment.captured) is also a no-op
  const other = await webhook('order.paid', ent);
  assert.equal(other.status, 200);
  assert.equal((await payment(b.id)).transactions.filter((t) => t.type === 'CAPTURED').length, 1);
});

test('a failed webhook run is retried (5xx) rather than lost, then succeeds once', async () => {
  const c = await makeUser('wr-c', 'CUSTOMER');
  const w = await makeWorker('wr-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const ent = gw.pay(o.data.orderId);
  const eventId = `evt_${tag}_retry`;
  // a malformed entity makes processing throw (not merely be ignored)
  const bad = { ...ent, order_id: { not: 'a string' } };
  const r1 = await webhook('payment.captured', bad, { eventId });
  assert.ok(r1.status === 200 || r1.status === 500);
  const row = await prisma.webhookEvent.findUnique({ where: { eventId } });
  assert.ok(row, 'the event is recorded');
  if (r1.status === 500) assert.equal(row.status, 'FAILED');
  const r2 = await webhook('payment.captured', ent, { eventId });
  assert.equal(r2.status, 200);
  assert.equal((await payment(b.id)).state, 'CAPTURED');
});

// ─── Duplicate payment prevention ───────────────────────────────────────────

test('duplicate prevention: one open order per booking, even under concurrent requests', async () => {
  const c = await makeUser('dp-c', 'CUSTOMER');
  const w = await makeWorker('dp-w');
  const b = await makeBooking({ customer: c, worker: w });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => orderFor(c.token, b.id)));
  assert.ok(results.every((r) => r.status === 200 || r.status === 201), JSON.stringify(results.map((r) => r.data)));
  assert.equal(new Set(results.map((r) => r.data.orderId)).size, 1, 'every caller got the same order');
  assert.equal(gw.count('orders.create'), 1, 'only one gateway order exists');
  assert.equal(await prisma.payment.count({ where: { bookingId: b.id } }), 1);
});

test('duplicate prevention: a paid booking cannot be paid again', async () => {
  const c = await makeUser('dp2-c', 'CUSTOMER');
  const w = await makeWorker('dp2-w');
  const b = await makeBooking({ customer: c, worker: w });
  await payFully(c, b);
  const r = await orderFor(c.token, b.id);
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'ALREADY_PAID');
  assert.equal(gw.count('orders.create'), 1);
});

test('duplicate prevention: a second payment on the same order (two tabs) is refunded automatically', async () => {
  const c = await makeUser('dp3-c', 'CUSTOMER');
  const w = await makeWorker('dp3-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const first = gw.pay(o.data.orderId);
  const second = gw.pay(o.data.orderId);
  assert.equal((await verifyFor(c.token, b.id, o.data.orderId, first.id)).status, 200);
  const v2 = await verifyFor(c.token, b.id, o.data.orderId, second.id);
  assert.equal(v2.status, 200);
  assert.equal(v2.data.duplicate, true);

  const p = await payment(b.id);
  assert.equal(p.gatewayPaymentId, first.id, 'the first payment stays the booking payment');
  assert.equal(p.state, 'CAPTURED');
  assert.equal(money(p.amountRefunded), 0, 'the duplicate does not count as a refund of the booking payment');
  const dup = p.refunds.filter((r) => r.kind === 'DUPLICATE_PAYMENT');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].gatewayPaymentId, second.id);
  assert.equal(gw.paymentStore.get(second.id).amount_refunded, 105900, 'the whole duplicate was refunded at the gateway');
  assert.equal(gw.paymentStore.get(first.id).amount_refunded, 0);

  // the webhook for the duplicate and a second callback do not refund again
  await webhook('payment.captured', gw.paymentStore.get(second.id));
  await verifyFor(c.token, b.id, o.data.orderId, second.id);
  assert.equal(await prisma.paymentRefund.count({ where: { paymentId: p.id, kind: 'DUPLICATE_PAYMENT' } }), 1);
  assert.equal(gw.count('payments.refund'), 1);
  assert.equal(await prisma.workerSettlement.count({ where: { paymentId: p.id } }), 1);
});

test('a payment captured after the booking was cancelled is refunded straight back', async () => {
  const c = await makeUser('late-c', 'CUSTOMER');
  const w = await makeWorker('late-w');
  const b = await makeBooking({ customer: c, worker: w });
  const o = await orderFor(c.token, b.id);
  const cancel = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'CANCELLED', notes: 'Changed my mind' } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  const ent = gw.pay(o.data.orderId); // customer still had the Checkout window open
  const r = await webhook('payment.captured', ent);
  assert.equal(r.status, 200);
  const p = await payment(b.id);
  assert.equal(p.state, 'REFUNDED');
  assert.equal(money(p.amountRefunded), 1059);
});

// ─── Completion ─────────────────────────────────────────────────────────────

test('completion: only the customer, only after payment; worker cannot complete; earnings become eligible', async () => {
  const c = await makeUser('cmp-c', 'CUSTOMER');
  const other = await makeUser('cmp-o', 'CUSTOMER');
  const w = await makeWorker('cmp-w');
  const b = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });

  // unpaid: refused
  let r = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'COMPLETED' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'PAYMENT_REQUIRED');
  r = await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: c.token });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'PAYMENT_REQUIRED');

  await payFully(c, b);
  // the worker can never complete a booking, only ask for confirmation
  r = await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'COMPLETED' } });
  assert.equal(r.status, 400);
  r = await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: w.token });
  assert.equal(r.status, 403);
  r = await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: other.token });
  assert.equal(r.status, 403);
  assert.equal((await payment(b.id)).settlement.status, 'PENDING_COMPLETION');

  r = await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'AWAITING_CUSTOMER_CONFIRMATION' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(await prisma.notification.findFirst({ where: { userId: c.user.id, title: 'Please confirm the service' } }));
  assert.equal((await payment(b.id)).settlement.status, 'PENDING_COMPLETION', 'still not payable to the worker');

  r = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'COMPLETED' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = await payment(b.id);
  assert.equal(p.settlement.status, 'ELIGIBLE');
  assert.ok(p.settlement.eligibleAt);
  assert.equal(p.settlement.payoutRail, null, 'no payout rail: owed, never reported as paid');
  assert.equal(p.settlement.paidAt, null);
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'COMPLETED');
  assert.equal(route.calls.length, 0);

  // confirming twice does not create a second entitlement
  r = await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: c.token });
  assert.equal(r.status, 409);
  assert.equal(await prisma.workerSettlement.count({ where: { paymentId: p.id } }), 1);
  assert.equal(await prisma.paymentTransaction.count({ where: { paymentId: p.id, type: 'COMPLETION_CONFIRMED' } }), 1);
});

test('completion is refused while disputed or while a refund is in progress', async () => {
  const c = await makeUser('blk-c', 'CUSTOMER');
  const w = await makeWorker('blk-w');
  const admin = await makeUser('blk-a', 'ADMIN');

  const d = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });
  await payFully(c, d);
  let r = await api('POST', `/api/payments/booking/${d.id}/dispute`, { token: c.token, json: { reason: 'Work is not what we agreed' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.ticketId);
  const pd = await payment(d.id);
  assert.equal(pd.disputed, true);
  assert.equal(pd.settlement.status, 'BLOCKED');
  assert.equal((await prisma.booking.findUnique({ where: { id: d.id } })).status, 'DISPUTED');
  r = await api('POST', `/api/payments/booking/${d.id}/confirm-completion`, { token: c.token });
  assert.equal(r.status, 409);
  r = await api('PUT', `/api/bookings/${d.id}/status`, { token: c.token, json: { status: 'COMPLETED' } });
  assert.ok([400, 409].includes(r.status));
  assert.equal((await api('POST', `/api/payments/booking/${d.id}/dispute`, { token: c.token, json: { reason: 'again' } })).status, 409);

  // a refund that is still pending blocks completion
  const rf = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });
  await payFully(c, rf);
  gw.refundStatus = 'pending';
  const pr = await payment(rf.id);
  r = await api('POST', `/api/admin/payments/${pr.id}/refund`, { token: admin.token, json: { amount: 100, reason: 'Goodwill' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund.status, 'PENDING');
  r = await api('POST', `/api/payments/booking/${rf.id}/confirm-completion`, { token: c.token });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'REFUND_IN_PROGRESS');
});

test('dispute resolution by an admin: release to worker, full refund, partial refund', async () => {
  const c = await makeUser('dr-c', 'CUSTOMER');
  const w = await makeWorker('dr-w');
  const admin = await makeUser('dr-a', 'ADMIN');
  const open = async () => {
    const b = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });
    await payFully(c, b);
    await api('POST', `/api/payments/booking/${b.id}/dispute`, { token: w.token, json: { reason: 'Customer will not accept the work' } });
    return { b, p: await payment(b.id) };
  };

  // non-admins cannot resolve
  let { b, p } = await open();
  assert.equal((await api('POST', `/api/admin/payments/${p.id}/resolve-dispute`, { token: c.token, json: { decision: 'REFUND_FULL', reason: 'give me my money' } })).status, 403);
  assert.equal((await api('POST', `/api/admin/payments/${p.id}/resolve-dispute`, { token: w.token, json: { decision: 'RELEASE_TO_WORKER', reason: 'pay me please' } })).status, 403);
  // a reason is mandatory
  assert.equal((await api('POST', `/api/admin/payments/${p.id}/resolve-dispute`, { token: admin.token, json: { decision: 'REFUND_FULL' } })).status, 400);

  let r = await api('POST', `/api/admin/payments/${p.id}/resolve-dispute`, { token: admin.token, json: { decision: 'RELEASE_TO_WORKER', reason: 'Work verified complete by photos' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  p = await payment(b.id);
  assert.equal(p.disputed, false);
  assert.equal(p.settlement.status, 'ELIGIBLE');
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'COMPLETED');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_DISPUTE_RESOLVED', entityId: p.id, userId: admin.user.id } }));

  ({ b, p } = await open());
  r = await api('POST', `/api/admin/payments/${p.id}/resolve-dispute`, { token: admin.token, json: { decision: 'REFUND_FULL', reason: 'Work was never done' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  p = await payment(b.id);
  assert.equal(p.state, 'REFUNDED');
  assert.equal(p.settlement.status, 'CANCELLED');
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'CANCELLED');

  ({ b, p } = await open());
  r = await api('POST', `/api/admin/payments/${p.id}/resolve-dispute`, { token: admin.token, json: { decision: 'REFUND_PARTIAL', amount: 300, reason: 'Half the work was done' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  p = await payment(b.id);
  assert.equal(p.state, 'PARTIALLY_REFUNDED');
  assert.equal(money(p.amountRefunded), 300);
  assert.equal(p.settlement.status, 'ELIGIBLE', 'released after the refund so the worker is paid the reduced amount');
  assert.equal(money(p.settlement.netAmount), 630, '(1000 - 300) less 10% commission');
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'COMPLETED');
});

// ─── Cancellation ───────────────────────────────────────────────────────────

test('customer cancellation: full refund before the worker is on the way', async () => {
  const c = await makeUser('cc-c', 'CUSTOMER');
  const w = await makeWorker('cc-w');
  const b = await makeBooking({ customer: c, worker: w, status: 'CONFIRMED' });
  await payFully(c, b);
  const r = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'CANCELLED', notes: 'No longer needed' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund.refunded, true);
  const p = await payment(b.id);
  assert.equal(p.state, 'REFUNDED');
  assert.equal(money(p.amountRefunded), 1059);
  assert.equal(p.settlement.status, 'CANCELLED');
  assert.equal(money(p.settlement.netAmount), 0);
  assert.equal(p.refunds[0].kind, 'CUSTOMER_CANCELLATION');
  assert.equal(gw.paymentStore.get(p.gatewayPaymentId).amount_refunded, 105900);
  assert.ok(await prisma.notification.findFirst({ where: { userId: w.user.id, type: 'BOOKING_CANCELLED', bookingId: b.id } }));
});

test('customer cancellation after the worker is on the way: cancellation fee kept for the worker', async () => {
  const c = await makeUser('cf-c', 'CUSTOMER');
  const w = await makeWorker('cf-w');
  const b = await makeBooking({ customer: c, worker: w, status: 'DISPATCHED' });
  await payFully(c, b);
  const r = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'CANCELLED' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = await payment(b.id);
  // fee = 10% of the service amount = 100; refunded = 1059 - 100
  assert.equal(money(p.amountRefunded), 959);
  assert.equal(p.state, 'PARTIALLY_REFUNDED');
  assert.equal(money(p.settlement.serviceAmount), 1000);
  assert.equal(money(p.settlement.netAmount), 90, 'the retained 100 goes to the worker less 10% commission');
  assert.equal(p.settlement.status, 'ELIGIBLE', 'the booking is over, so the retained share is owed now rather than waiting for a completion');
  assert.equal(money(p.settlement.commission), 10);
  assert.equal(money(p.settlement.refundAdjustment), 810);
});

test('worker cancellation: customer is refunded in full, no fee, worker earns nothing', async () => {
  const c = await makeUser('wc-c', 'CUSTOMER');
  const w = await makeWorker('wc-w');
  const b = await makeBooking({ customer: c, worker: w, status: 'DISPATCHED' });
  await payFully(c, b);
  const r = await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'CANCELLED', notes: 'Vehicle broke down' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const p = await payment(b.id);
  assert.equal(p.state, 'REFUNDED');
  assert.equal(money(p.amountRefunded), 1059);
  assert.equal(p.refunds[0].kind, 'WORKER_CANCELLATION');
  assert.equal(p.settlement.status, 'CANCELLED');
  const earn = await api('GET', '/api/worker/earnings', { token: w.token });
  assert.equal(earn.data.summary.totalEarnings, 0);
  assert.equal(earn.data.summary.availableBalance, 0);
  assert.equal(earn.data.summary.pendingSettlements, 0);
});

test('cancelling an unpaid booking needs no refund; a refund failure never blocks the cancellation', async () => {
  const c = await makeUser('cu-c', 'CUSTOMER');
  const w = await makeWorker('cu-w');
  const unpaid = await makeBooking({ customer: c, worker: w });
  const r = await api('PUT', `/api/bookings/${unpaid.id}/status`, { token: c.token, json: { status: 'CANCELLED' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.refund, undefined);

  const paid = await makeBooking({ customer: c, worker: w });
  await payFully(c, paid);
  gw.failRefund = true;
  const r2 = await api('PUT', `/api/bookings/${paid.id}/status`, { token: c.token, json: { status: 'CANCELLED' } });
  assert.equal(r2.status, 200, 'booking is cancelled even though the gateway refused the refund');
  const p = await payment(paid.id);
  assert.equal(p.state, 'CAPTURED', 'money is NOT reported refunded');
  assert.equal(p.refunds[0].status, 'FAILED');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_REFUND_FAILED', entityId: p.id } }));

  // an admin can retry the refund afterwards
  gw.failRefund = false;
  const admin = await makeUser('cu-a', 'ADMIN');
  const retry = await api('POST', `/api/admin/payments/${p.id}/refund`, { token: admin.token, json: { reason: 'Retry after gateway failure' } });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal((await payment(paid.id)).state, 'REFUNDED');
});

// ─── Refunds ────────────────────────────────────────────────────────────────

test('admin refund: full refund adjusts payment, ledger and worker settlement; authorization and limits enforced', async () => {
  const c = await makeUser('rf-c', 'CUSTOMER');
  const w = await makeWorker('rf-w');
  const admin = await makeUser('rf-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w });
  await payFully(c, b);
  const p0 = await payment(b.id);

  for (const who of [c, w]) {
    assert.equal((await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: who.token, json: { reason: 'x' } })).status, 403, 'only admins can refund');
  }
  assert.equal((await api('POST', `/api/admin/payments/${p0.id}/refund`, { json: { reason: 'x' } })).status, 401);

  let r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: 5000, reason: 'too much' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'EXCEEDS_REFUNDABLE');
  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: -5, reason: 'negative' } });
  assert.equal(r.status, 400);
  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: 'abc' } });
  assert.equal(r.status, 400);

  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { reason: 'Service unavailable' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund.amount, 1059);
  assert.equal(r.data.refund.status, 'PROCESSED');
  const p = await payment(b.id);
  assert.equal(p.state, 'REFUNDED');
  assert.equal(money(p.amountRefunded), 1059);
  assert.equal(p.settlement.status, 'CANCELLED');
  assert.ok(p.transactions.some((t) => t.type === 'REFUND_INITIATED'));
  assert.ok(p.transactions.some((t) => t.type === 'REFUND_PROCESSED'));
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_REFUND_INITIATED', entityId: p.id, userId: admin.user.id } }));

  // nothing left to refund
  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { reason: 'again' } });
  assert.equal(r.status, 409);
  assert.equal(gw.count('payments.refund'), 1);
});

test('partial refunds: state, amounts and the worker settlement stay consistent, and cannot exceed the payment', async () => {
  const c = await makeUser('pr-c', 'CUSTOMER');
  const w = await makeWorker('pr-w');
  const admin = await makeUser('pr-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w, price: 1000 });
  await payFully(c, b);
  const p0 = await payment(b.id);

  let r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: 200, reason: 'Partial work' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let p = await payment(b.id);
  assert.equal(p.state, 'PARTIALLY_REFUNDED');
  assert.equal(money(p.amountRefunded), 200);
  assert.deepEqual([money(p.settlement.commission), money(p.settlement.netAmount), money(p.settlement.refundAdjustment)], [80, 720, 180], 'worker bears the refund, platform returns its commission share');
  assert.equal(p.settlement.status, 'PENDING_COMPLETION');

  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: 300, reason: 'More' } });
  assert.equal(r.status, 200);
  p = await payment(b.id);
  assert.equal(money(p.amountRefunded), 500);
  assert.equal(money(p.settlement.netAmount), 450);

  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: 600, reason: 'Too much' } });
  assert.equal(r.status, 409, 'remaining refundable is only 559');

  r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { reason: 'Refund the rest' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.refund.amount, 559);
  p = await payment(b.id);
  assert.equal(p.state, 'REFUNDED');
  assert.equal(money(p.amountRefunded), 1059);
  assert.equal(p.settlement.status, 'CANCELLED');
  assert.equal(money(p.settlement.netAmount), 0);
});

test('a pending refund is finalised exactly once by refund.processed webhooks (even when replayed)', async () => {
  const c = await makeUser('pw-c', 'CUSTOMER');
  const w = await makeWorker('pw-w');
  const admin = await makeUser('pw-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w });
  await payFully(c, b);
  const p0 = await payment(b.id);
  gw.refundStatus = 'pending';
  const r = await api('POST', `/api/admin/payments/${p0.id}/refund`, { token: admin.token, json: { amount: 400, reason: 'Goodwill' } });
  assert.equal(r.data.refund.status, 'PENDING');
  let p = await payment(b.id);
  assert.equal(p.state, 'CAPTURED', 'not reported refunded until the provider says so');
  assert.equal(money(p.amountRefunded), 0);

  const rfnd = { ...[...gw.refundStore.values()][0], status: 'processed' };
  const a = await webhook('refund.processed', rfnd, { eventId: `evt_${tag}_rf1` });
  const again = await webhook('refund.processed', rfnd, { eventId: `evt_${tag}_rf1` });
  const sameRefundNewEvent = await webhook('refund.processed', rfnd, { eventId: `evt_${tag}_rf2` });
  assert.deepEqual([a.status, again.status, sameRefundNewEvent.status], [200, 200, 200]);
  assert.equal(again.data.result, 'DUPLICATE');
  p = await payment(b.id);
  assert.equal(p.state, 'PARTIALLY_REFUNDED');
  assert.equal(money(p.amountRefunded), 400, 'applied once, not three times');
  assert.equal(p.transactions.filter((t) => t.type === 'REFUND_PROCESSED').length, 1);

  // a refund that fails at the provider is recorded as failed, not as money returned
  const b2 = await makeBooking({ customer: c, worker: w });
  await payFully(c, b2);
  const p2 = await payment(b2.id);
  const r2 = await api('POST', `/api/admin/payments/${p2.id}/refund`, { token: admin.token, json: { amount: 100, reason: 'Will fail' } });
  const failedRefund = { ...[...gw.refundStore.values()].pop(), status: 'failed' };
  await webhook('refund.failed', failedRefund);
  const after = await payment(b2.id);
  assert.equal(after.state, 'CAPTURED');
  assert.equal(after.refunds.find((x) => x.id === r2.data.refund.id).status, 'FAILED');
});

test('refunds created in the Razorpay dashboard are reconciled', async () => {
  const c = await makeUser('dash-c', 'CUSTOMER');
  const w = await makeWorker('dash-w');
  const b = await makeBooking({ customer: c, worker: w });
  const { entity } = await payFully(c, b);
  const dashRefund = { id: 'rfnd_dash_1', entity: 'refund', payment_id: entity.id, amount: 50000, status: 'processed', receipt: null };
  const r = await webhook('refund.processed', dashRefund);
  assert.equal(r.status, 200);
  const p = await payment(b.id);
  assert.equal(p.state, 'PARTIALLY_REFUNDED');
  assert.equal(money(p.amountRefunded), 500);
  assert.equal(p.refunds[0].kind, 'DASHBOARD');
});

// ─── Customer history / privacy ─────────────────────────────────────────────

test('customer transaction history shows only that customer\'s payments with the required fields', async () => {
  const c1 = await makeUser('h1-c', 'CUSTOMER');
  const c2 = await makeUser('h2-c', 'CUSTOMER');
  const w = await makeWorker('h-w');
  const admin = await makeUser('h-a', 'ADMIN');
  const b1 = await makeBooking({ customer: c1, worker: w, description: 'Fix kitchen sink' });
  const b2 = await makeBooking({ customer: c2, worker: w, description: 'Secret job of customer two' });
  const unpaid = await makeBooking({ customer: c1, worker: w });
  await payFully(c1, b1, { method: 'upi' });
  await payFully(c2, b2);
  await orderFor(c1.token, unpaid.id); // an order that was never paid is not a transaction
  await api('POST', `/api/admin/payments/${(await payment(b1.id)).id}/refund`, { token: admin.token, json: { amount: 100, reason: 'Goodwill' } });

  const h = await api('GET', '/api/payments/history', { token: c1.token });
  assert.equal(h.status, 200);
  assert.equal(h.data.payments.length, 1);
  const row = h.data.payments[0];
  assert.equal(row.bookingNumber, b1.bookingNumber);
  assert.equal(row.workerName, w.user.name);
  assert.equal(row.service, 'Fix kitchen sink');
  assert.equal(row.totalAmount, 1059);
  assert.ok(row.capturedAt);
  assert.equal(row.method, 'upi');
  assert.equal(row.state, 'PARTIALLY_REFUNDED');
  assert.equal(row.refundStatus, 'PARTIALLY_REFUNDED');
  assert.equal(row.amountRefunded, 100);
  const text = JSON.stringify(h.data);
  assert.equal(text.includes('Secret job'), false);
  assert.equal(text.includes(c2.user.email), false);
  assert.equal(/commission|netAmount|settlement/i.test(text), false, 'customers never see the worker\'s side of the money');

  const d = await api('GET', `/api/payments/${row.id}`, { token: c1.token });
  assert.equal(d.status, 200);
  assert.equal(d.data.payment.serviceAmount, 1000);
  assert.equal(d.data.payment.platformFee, 50);
  assert.equal(d.data.payment.taxAmount, 9);
  assert.equal(d.data.payment.refunds.length, 1);
  assert.ok(d.data.payment.timeline.some((t) => t.type === 'CAPTURED'));
  assert.equal(/commission|netAmount|settlement|gateway/i.test(JSON.stringify(d.data)), false);
  assert.equal((await api('GET', `/api/payments/${row.id}`, { token: c2.token })).status, 404);

  const h2 = await api('GET', '/api/payments/history', { token: c2.token });
  assert.equal(h2.data.payments.length, 1);
  assert.equal(h2.data.payments[0].bookingNumber, b2.bookingNumber);
});

test('booking payloads give each side only its own view of the payment (no raw payment rows)', async () => {
  const c = await makeUser('bp-c', 'CUSTOMER');
  const w = await makeWorker('bp-w');
  const admin = await makeUser('bp-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w });
  const { entity } = await payFully(c, b, { method: 'upi' });

  const asWorker = await api('GET', '/api/bookings/my', { token: w.token });
  const wb = asWorker.data.bookings.find((x) => x.id === b.id);
  assert.equal(wb.payment.paid, true);
  assert.equal(wb.payment.settlement.netAmount, 900);
  const wText = JSON.stringify(wb.payment);
  for (const secret of [entity.id, 'order_', 'UPI', 'upi', '1059', 'platformFee', 'gateway', 'method']) assert.equal(wText.includes(secret), false, `worker sees "${secret}"`);
  const single = await api('GET', `/api/bookings/${b.id}`, { token: w.token });
  assert.equal(JSON.stringify(single.data.booking.payment).includes(entity.id), false);

  const asCustomer = await api('GET', '/api/bookings/my', { token: c.token });
  const cb = asCustomer.data.bookings.find((x) => x.id === b.id);
  assert.equal(cb.payment.totalAmount, 1059);
  const cText = JSON.stringify(cb.payment);
  assert.equal(cText.includes(entity.id), false);
  assert.equal(/commission|netAmount|settlement/i.test(cText), false, 'customers never see the worker settlement');

  const asAdmin = await api('GET', `/api/bookings/${b.id}`, { token: admin.token });
  assert.equal(asAdmin.data.booking.payment.settlement.netAmount, 900);
  assert.equal(JSON.stringify(asAdmin.data.booking.payment).includes(entity.id), false, 'gateway ids stay on the server');
});

// ─── Worker earnings ────────────────────────────────────────────────────────

test('worker earnings come from settlement records only and never include other workers or customer payment details', async () => {
  const c = await makeUser('e-c', 'CUSTOMER');
  const w = await makeWorker('e-w');
  const w2 = await makeWorker('e-w2');

  let r = await api('GET', '/api/worker/earnings', { token: w.token });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.values(r.data.summary).filter((v) => typeof v === 'number' && v !== 0), [], 'a new worker has zero everything');
  assert.deepEqual(r.data.settlements, []);
  assert.deepEqual(r.data.payoutHistory, []);

  const done = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS', price: 1000 });
  await payFully(c, done);
  const waiting = await makeBooking({ customer: c, worker: w, status: 'CONFIRMED', price: 500 });
  await payFully(c, waiting);
  const unpaid = await makeBooking({ customer: c, worker: w, status: 'CONFIRMED', price: 777 });
  await orderFor(c.token, unpaid.id);
  const refunded = await makeBooking({ customer: c, worker: w, status: 'CONFIRMED', price: 400 });
  await payFully(c, refunded);
  await api('PUT', `/api/bookings/${refunded.id}/status`, { token: w.token, json: { status: 'CANCELLED' } });
  const other = await makeBooking({ customer: c, worker: w2, status: 'CONFIRMED', price: 9000 });
  await payFully(c, other);

  assert.equal((await api('PUT', `/api/bookings/${done.id}/status`, { token: w.token, json: { status: 'AWAITING_CUSTOMER_CONFIRMATION' } })).status, 200);
  assert.equal((await api('PUT', `/api/bookings/${done.id}/status`, { token: c.token, json: { status: 'COMPLETED' } })).status, 200);

  r = await api('GET', '/api/worker/earnings', { token: w.token });
  const s = r.data.summary;
  assert.equal(s.totalEarnings, 900, 'only the confirmed job: 1000 less 10% commission');
  assert.equal(s.availableBalance, 900, 'owed, not yet paid out (no payout rail)');
  assert.equal(s.pendingSettlements, 450, 'paid but not yet confirmed: 500 less commission');
  assert.equal(s.completedJobs, 1);
  assert.equal(s.platformCommission, 100);
  assert.equal(s.refundAdjustments, 360, 'the refunded job: 400 less 10% commission would have been owed');
  assert.equal(s.paidOut, 0);
  assert.equal(r.data.payoutRail, 'NONE');
  assert.equal(r.data.settlements.length, 3, 'unpaid, refunded and others are not listed as earnings');
  assert.equal(r.data.payoutHistory.length, 0, 'no payouts were made, so no payout history is invented');
  const text = JSON.stringify(r.data);
  const amounts = r.data.settlements.flatMap((t) => [t.serviceAmount, t.netAmount, t.commission]).concat(Object.values(r.data.summary));
  assert.equal(amounts.some((v) => v === 9000 || v === 8100), false, "another worker's money never appears");
  assert.equal(text.includes(c.user.email), false);
  assert.equal(/card|upi|Visa|gatewayPaymentId|pay_\d/i.test(text), false, 'no customer payment instrument details');

  // the dashboard endpoint agrees
  const dash = await api('GET', '/api/worker/dashboard', { token: w.token });
  assert.equal(dash.data.earnings.availableBalance, 900);
  assert.equal(dash.data.earnings.completedJobs, 1);

  // other roles cannot read it
  assert.equal((await api('GET', '/api/worker/earnings', { token: c.token })).status, 403);
  assert.equal((await api('GET', '/api/worker/earnings')).status, 401);
});

// ─── Payouts: ledger-only default ───────────────────────────────────────────

test('without Razorpay Route nothing is ever reported as paid out and no transfer is attempted', async () => {
  const c = await makeUser('lo-c', 'CUSTOMER');
  const w = await makeWorker('lo-w');
  const admin = await makeUser('lo-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });
  await payFully(c, b);
  await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'COMPLETED' } });
  const p = await payment(b.id);
  assert.equal(p.settlement.status, 'ELIGIBLE');
  assert.equal(route.calls.length, 0);
  const status = await api('GET', '/api/admin/payments/payout-status', { token: admin.token });
  assert.equal(status.data.payoutMode, 'LEDGER_ONLY');
  assert.equal(status.data.routeEnabledInConfig, false);
  // payout account onboarding is refused when Route is not enabled
  const acc = await api('POST', '/api/worker/payout-account', { token: w.token, json: {} });
  assert.equal(acc.status, 409);
  assert.equal(acc.data.code, 'ROUTE_DISABLED');
  // retry only applies to failed payouts
  const retry = await api('POST', `/api/admin/settlements/${p.settlement.id}/retry`, { token: admin.token });
  assert.equal(retry.status, 409);
});

// ─── Payouts: Route mode against a test double ──────────────────────────────

const validAccount = { legalName: 'Ravi Kumar Sharma', pan: 'ABCDE1234F', phone: '9876543210', street: '12 MG Road', city: 'Belagavi', state: 'Karnataka', postalCode: '590001', accountNumber: '123456789012', ifsc: 'HDFC0001234', beneficiaryName: 'Ravi Kumar Sharma' };

async function routeWorker(label) {
  const w = await makeWorker(label);
  await prisma.workerPayoutAccount.create({ data: { userId: w.user.id, status: 'ACTIVATED', gatewayAccountId: `acc_${label}`, gatewayProductId: 'prd_x', legalName: 'Test', bankLast4: '9012' } });
  return w;
}

test('ROUTE mode: payout account onboarding validates input, never stores bank details, and handles Route not enabled', async () => {
  process.env.PAYOUT_MODE = 'ROUTE';
  routeClient.setHttpClient(route.client());
  const w = await makeWorker('on-w');

  let r = await api('POST', '/api/worker/payout-account', { token: w.token, json: { ...validAccount, pan: 'bad', ifsc: 'xx', accountNumber: '12' } });
  assert.equal(r.status, 400);
  assert.ok(r.data.errors.pan && r.data.errors.ifsc && r.data.errors.accountNumber);
  assert.equal(route.calls.length, 0, 'invalid input never reaches the provider');

  route.nextProductStatus = 'under_review';
  r = await api('POST', '/api/worker/payout-account', { token: w.token, json: validAccount });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.account.status, 'UNDER_REVIEW');
  assert.equal(r.data.account.bankLast4, '9012');
  const stored = JSON.stringify(await prisma.workerPayoutAccount.findUnique({ where: { userId: w.user.id } }));
  assert.equal(stored.includes('123456789012'), false, 'full account number is never stored');
  assert.equal(stored.includes('ABCDE1234F'), false, 'PAN is never stored');
  assert.equal(JSON.stringify(r.data).includes('ABCDE1234F'), false);

  // provider activates the account; sync picks it up
  route.nextProductStatus = 'activated';
  r = await api('POST', '/api/worker/payout-account/sync', { token: w.token });
  assert.equal(r.data.account.status, 'ACTIVATED');
  assert.equal((await api('POST', '/api/worker/payout-account', { token: w.token, json: validAccount })).status, 409, 'already active');

  // Route not enabled for the merchant: a clear, honest error
  const w2 = await makeWorker('on-w2');
  route.reset();
  route.notEnabled = true;
  r = await api('POST', '/api/worker/payout-account', { token: w2.token, json: validAccount });
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'ROUTE_NOT_ENABLED');
});

test('ROUTE mode: customers cannot pay for a worker whose payout account is not active', async () => {
  process.env.PAYOUT_MODE = 'ROUTE';
  routeClient.setHttpClient(route.client());
  const c = await makeUser('rg-c', 'CUSTOMER');
  const w = await makeWorker('rg-w');
  const b = await makeBooking({ customer: c, worker: w });
  const r = await orderFor(c.token, b.id);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'WORKER_PAYOUT_NOT_READY');
  assert.equal(gw.count('orders.create'), 0);
});

test('ROUTE mode: held transfer at capture, released on customer confirmation, settled by transfer webhooks', async () => {
  process.env.PAYOUT_MODE = 'ROUTE';
  routeClient.setHttpClient(route.client());
  const c = await makeUser('rt-c', 'CUSTOMER');
  const w = await routeWorker('rt-w');
  const b = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });
  await payFully(c, b);

  let p = await payment(b.id);
  assert.equal(p.settlement.status, 'PENDING_COMPLETION');
  assert.ok(p.settlement.gatewayTransferId, 'a transfer exists after capture');
  const t = route.transfers.get(p.settlement.gatewayTransferId);
  assert.equal(t.on_hold, true, 'the worker share is ON HOLD until the customer confirms');
  assert.equal(t.amount, 90000);
  assert.equal(t.recipient, 'acc_rt-w');
  assert.equal(p.settlement.settlementStatus, 'on_hold');

  const done = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'COMPLETED' } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.payoutDispatched, true);
  p = await payment(b.id);
  assert.equal(route.transfers.get(p.settlement.gatewayTransferId).on_hold, false, 'hold released');
  assert.equal(p.settlement.status, 'PAYOUT_PROCESSING', 'not PAID until the provider says so');
  assert.equal(p.settlement.paidAt, null);
  assert.equal(route.count('POST /v1/payments'), 1, 'exactly one transfer was created');

  const earn = await api('GET', '/api/worker/earnings', { token: w.token });
  assert.equal(earn.data.summary.paidOut, 0);
  assert.equal(earn.data.summary.payoutProcessing, 900);
  assert.equal(earn.data.payoutRail, 'RAZORPAY_ROUTE');

  // provider: transfer processed but not yet settled -> still processing
  const entity = { id: p.settlement.gatewayTransferId, status: 'processed', settlement_status: 'pending' };
  let wh = await webhook('transfer.processed', entity);
  assert.equal(wh.status, 200);
  assert.equal((await payment(b.id)).settlement.status, 'PAYOUT_PROCESSING');
  // provider: settled to the bank -> PAID
  const settled = { ...entity, settlement_status: 'settled' };
  const eventId = `evt_${tag}_settled`;
  wh = await webhook('transfer.processed', settled, { eventId });
  await webhook('transfer.processed', settled, { eventId });
  p = await payment(b.id);
  assert.equal(p.settlement.status, 'PAID');
  assert.ok(p.settlement.paidAt);
  assert.equal(p.settlement.settlementStatus, 'settled');
  const hist = await api('GET', '/api/worker/earnings', { token: w.token });
  assert.equal(hist.data.summary.paidOut, 900);
  assert.equal(hist.data.payoutHistory.length, 1);
  assert.equal(hist.data.payoutHistory[0].status, 'PAID');
  assert.ok(await prisma.notification.findFirst({ where: { userId: w.user.id, title: 'Payout settled' } }));
});

test('ROUTE mode: payout failure is recorded, visible, and retryable by an admin without a duplicate transfer', async () => {
  process.env.PAYOUT_MODE = 'ROUTE';
  routeClient.setHttpClient(route.client());
  const c = await makeUser('pf-c', 'CUSTOMER');
  const w = await routeWorker('pf-w');
  const admin = await makeUser('pf-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w, status: 'IN_PROGRESS' });
  route.failTransfer = true; // the held transfer cannot be created at capture time
  await payFully(c, b);
  let p = await payment(b.id);
  assert.equal(p.settlement.gatewayTransferId, null);
  assert.match(p.settlement.failureReason, /Transfer not created/);

  // completion: dispatch also fails -> FAILED, but the customer's confirmation stands
  const done = await api('PUT', `/api/bookings/${b.id}/status`, { token: c.token, json: { status: 'COMPLETED' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.payoutDispatched, false);
  p = await payment(b.id);
  assert.equal(p.settlement.status, 'FAILED');
  assert.ok(p.settlement.failureReason);
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'COMPLETED');
  let earn = await api('GET', '/api/worker/earnings', { token: w.token });
  assert.equal(earn.data.summary.failedPayouts, 900);
  assert.equal(earn.data.summary.paidOut, 0);
  assert.equal(earn.data.payoutHistory[0].status, 'FAILED');

  // only admins retry
  assert.equal((await api('POST', `/api/admin/settlements/${p.settlement.id}/retry`, { token: w.token })).status, 403);
  assert.equal((await api('POST', `/api/admin/settlements/${p.settlement.id}/retry`, { token: c.token })).status, 403);

  route.failTransfer = false;
  const retry = await api('POST', `/api/admin/settlements/${p.settlement.id}/retry`, { token: admin.token });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  p = await payment(b.id);
  assert.equal(p.settlement.status, 'PAYOUT_PROCESSING');
  assert.equal(route.transfers.size, 1);
  assert.equal(p.settlement.attempts, 2);
  const again = await api('POST', `/api/admin/settlements/${p.settlement.id}/retry`, { token: admin.token });
  assert.equal(again.status, 409, 'a payout that is already processing cannot be retried into a duplicate transfer');
  assert.equal(route.transfers.size, 1);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYOUT_RETRIED', entityId: p.settlement.id } }));

  // provider later reports the transfer failed
  await webhook('transfer.failed', { id: p.settlement.gatewayTransferId, status: 'failed', error: { description: 'Beneficiary bank rejected the credit' } });
  p = await payment(b.id);
  assert.equal(p.settlement.status, 'FAILED');
  assert.match(p.settlement.failureReason, /Beneficiary bank/);
  earn = await api('GET', '/api/worker/earnings', { token: w.token });
  assert.equal(earn.data.summary.failedPayouts, 900);
  assert.ok(await prisma.notification.findFirst({ where: { userId: w.user.id, title: 'Payout problem' } }));
});

test('ROUTE mode: a refund reverses the worker share of the transfer; a full refund before release cancels it', async () => {
  process.env.PAYOUT_MODE = 'ROUTE';
  routeClient.setHttpClient(route.client());
  const c = await makeUser('rr-c', 'CUSTOMER');
  const w = await routeWorker('rr-w');
  const admin = await makeUser('rr-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w, status: 'CONFIRMED' });
  await payFully(c, b);
  let p = await payment(b.id);
  const tid = p.settlement.gatewayTransferId;
  const r = await api('POST', `/api/admin/payments/${p.id}/refund`, { token: admin.token, json: { amount: 200, reason: 'Partial' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(route.transfers.get(tid).amount_reversed, 18000, 'worker share reduced by 200 less 10% commission');
  p = await payment(b.id);
  assert.equal(money(p.settlement.netAmount), 720);
  assert.ok(p.transactions.some((t) => t.type === 'TRANSFER_REVERSED'));

  // if the reversal cannot be made, the customer refund does not go out
  route.failTransfer = false;
  const orig = route.client();
  routeClient.setHttpClient(async (m, path, body) => (/reversals$/.test(path) ? { status: 400, json: { error: { description: 'insufficient balance in linked account' } } } : orig(m, path, body)));
  const r2 = await api('POST', `/api/admin/payments/${p.id}/refund`, { token: admin.token, json: { amount: 100, reason: 'Second' } });
  assert.equal(r2.status, 502);
  assert.equal(r2.data.code, 'REVERSAL_FAILED');
  p = await payment(b.id);
  assert.equal(money(p.amountRefunded), 200, 'no second refund was made');
  assert.equal(gw.count('payments.refund'), 1);
});

// ─── Booking-flow fixes ─────────────────────────────────────────────────────

test('worker accepting a booking confirms the price (and may change it within limits)', async () => {
  const c = await makeUser('acc-c', 'CUSTOMER');
  const w = await makeWorker('acc-w');
  const b = await makeBooking({ customer: c, worker: w, status: 'REQUESTED', price: 800, priceConfirmed: false });

  assert.equal((await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'CONFIRMED', agreedPrice: 'abc' } })).status, 400);
  assert.equal((await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'CONFIRMED', agreedPrice: 1 } })).status, 400);
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).priceConfirmedAt, null);

  const r = await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'CONFIRMED', agreedPrice: 1000 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const saved = await prisma.booking.findUnique({ where: { id: b.id } });
  assert.ok(saved.priceConfirmedAt);
  assert.equal(money(saved.agreedPrice), 1000);
  const note = await prisma.notification.findFirst({ where: { userId: c.user.id, type: 'BOOKING_CONFIRMED' }, orderBy: { createdAt: 'desc' } });
  assert.match(note.message, /1000/);
  assert.match(note.message, /pay/i);

  // and now the customer can pay the confirmed price
  const q = await api('GET', `/api/payments/booking/${b.id}/quote`, { token: c.token });
  assert.equal(q.data.breakdown.serviceAmount, 1000);
  assert.equal(q.data.payable.ok, true);

  // a customer cannot raise the price on a request
  const b2 = await makeBooking({ customer: c, worker: w, status: 'REQUESTED', price: 500, priceConfirmed: false });
  const rr = await api('PUT', `/api/bookings/${b2.id}/status`, { token: c.token, json: { status: 'CONFIRMED', agreedPrice: 1 } });
  assert.ok([400, 403].includes(rr.status));
});

test('booking creation enforces the worker\'s working hours and blocked periods on the server', async () => {
  const c = await makeUser('hrs-c', 'CUSTOMER');
  const w = await makeWorker('hrs-w');
  // Mon-Fri 09:00-17:00 (Asia/Kolkata); nothing on weekends
  for (const d of [1, 2, 3, 4, 5]) await prisma.professionalAvailability.create({ data: { workerProfileId: w.profile.id, dayOfWeek: d, startTime: '09:00', endTime: '17:00', isActive: true } });
  const IST = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh, mm) - (5 * 60 + 30) * 60000);
  // find the next Wednesday and the next Sunday at least 3 days away
  const next = (dow) => { const dt = new Date(Date.now() + 3 * 86400000); while (new Date(dt.getTime() + 330 * 60000).getUTCDay() !== dow) dt.setUTCDate(dt.getUTCDate() + 1); const l = new Date(dt.getTime() + 330 * 60000); return [l.getUTCFullYear(), l.getUTCMonth() + 1, l.getUTCDate()]; };
  const [wy, wm, wd] = next(3);
  const [sy, sm, sd] = next(0);
  const book = (at) => api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: at.toISOString(), timeSlot: 'slot', agreedPrice: 500, problemDescription: 'Pipe burst in the bathroom' } });

  let r = await book(IST(wy, wm, wd, 10, 0));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await book(IST(wy, wm, wd, 8, 59));
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'OUTSIDE_WORKING_HOURS');
  assert.match(r.data.message, /09:00-17:00/);
  r = await book(IST(wy, wm, wd, 17, 0));
  assert.equal(r.status, 400, 'the end time itself is outside the working hours');
  r = await book(IST(wy, wm, wd, 16, 59));
  assert.equal(r.status, 201);
  r = await book(IST(sy, sm, sd, 11, 0));
  assert.equal(r.status, 400);
  assert.match(r.data.message, /Sunday/);

  // blocked period
  await prisma.professionalBlockedPeriod.create({ data: { workerProfileId: w.profile.id, startDateTime: IST(wy, wm, wd, 12, 0), endDateTime: IST(wy, wm, wd, 14, 0), reason: 'Holiday' } });
  r = await book(IST(wy, wm, wd, 13, 0));
  assert.equal(r.status, 400);
  assert.match(r.data.message, /unavailable/i);

  // a worker who has published no hours is not restricted
  const free = await makeWorker('hrs-free');
  r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: free.user.id, scheduledAt: IST(sy, sm, sd, 3, 0).toISOString(), timeSlot: 'slot', agreedPrice: 500, problemDescription: 'Anytime job' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
});

test('the booking-request notification contains the actual problem description', async () => {
  const c = await makeUser('nd-c', 'CUSTOMER');
  const w = await makeWorker('nd-w');
  const at = new Date(Date.now() + 3 * 86400000).toISOString();
  const description = 'The bathroom tap is dripping and there is water under the basin.';
  let r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: at, timeSlot: '10:00 - 12:00', agreedPrice: 500, problemDescription: description } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let n = await prisma.notification.findFirst({ where: { userId: w.user.id, type: 'BOOKING_REQUEST' }, orderBy: { createdAt: 'desc' } });
  assert.ok(n.message.includes(description), n.message);
  assert.match(n.message, /10:00 - 12:00/);

  const long = 'Water damage. '.repeat(40);
  r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: w.user.id, scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString(), timeSlot: 'x', agreedPrice: 500, problemDescription: long.slice(0, 600) } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  n = await prisma.notification.findFirst({ where: { userId: w.user.id, type: 'BOOKING_REQUEST' }, orderBy: { createdAt: 'desc' } });
  assert.ok(n.message.length < 400, 'long descriptions are truncated in the notification');
  assert.match(n.message, /Water damage/);
});

test('accepting a job quote creates a price-confirmed booking that can be paid', async () => {
  const c = await makeUser('qt-c', 'CUSTOMER');
  const w = await makeWorker('qt-w');
  const job = await prisma.jobPost.create({ data: { customerId: c.user.id, categoryId: plumber.id, title: `${tag} quote job`, description: 'Replace the old geyser in the bathroom.' } });
  let r = await api('POST', '/api/applications', { token: w.token, json: { jobId: job.id, quote: 1200, message: 'I can do this tomorrow' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const appId = r.data.application.id || r.data.application._id;
  r = await api('PUT', `/api/applications/${appId}/accept`, { token: c.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.bookingId);
  const booking = await prisma.booking.findUnique({ where: { id: r.data.bookingId } });
  assert.equal(booking.status, 'CONFIRMED');
  assert.ok(booking.priceConfirmedAt);
  assert.equal(money(booking.agreedPrice), 1200);
  assert.equal(booking.workerId, w.user.id);
  assert.equal(booking.customerId, c.user.id);
  const q = await api('GET', `/api/payments/booking/${booking.id}/quote`, { token: c.token });
  assert.equal(q.data.payable.ok, true);
  assert.equal(q.data.breakdown.serviceAmount, 1200);
  // accepting again does not create a second booking
  await api('PUT', `/api/applications/${appId}/accept`, { token: c.token });
  assert.equal(await prisma.booking.count({ where: { jobPostId: job.id } }), 1);
  await prisma.jobApplication.deleteMany({ where: { jobId: job.id } });
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: booking.id } });
  await prisma.booking.delete({ where: { id: booking.id } });
  await prisma.jobPost.delete({ where: { id: job.id } });
});

// ─── Admin ──────────────────────────────────────────────────────────────────

test('admin payment list and metrics reflect real records and are admin-only', async () => {
  const c = await makeUser('ad-c', 'CUSTOMER');
  const w = await makeWorker('ad-w');
  const admin = await makeUser('ad-a', 'ADMIN');
  const b = await makeBooking({ customer: c, worker: w });
  await payFully(c, b);
  const list = await api('GET', '/api/admin/payments?q=' + encodeURIComponent(b.bookingNumber), { token: admin.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.payments.length, 1);
  assert.equal(list.data.payments[0].state, 'CAPTURED');
  assert.equal(list.data.payments[0].settlement.status, 'PENDING_COMPLETION');
  assert.equal((await api('GET', '/api/admin/payments', { token: c.token })).status, 403);
  assert.equal((await api('GET', '/api/admin/payments', { token: w.token })).status, 403);
  const m = await api('GET', '/api/admin/metrics', { token: admin.token });
  assert.equal(m.status, 200);
  assert.ok(m.data.metrics.paymentTotals.count >= 1);
  assert.ok(m.data.metrics.heldInEscrow >= 900);
});

test('the removed escrow/simulated-payment endpoints are gone', async () => {
  const c = await makeUser('gone-c', 'CUSTOMER');
  for (const [m, p] of [['POST', '/api/escrow/fund'], ['POST', '/api/escrow/release'], ['POST', '/api/escrow/razorpay/verify'], ['POST', '/api/escrow/razorpay/order']]) {
    const r = await api(m, p, { token: c.token, json: { amount: 1 } });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
});

test('settlement service exposes no way to mark money paid without provider confirmation', () => {
  assert.equal(typeof settlementService.dispatchPayout, 'function');
  const exported = Object.keys(settlementService);
  assert.equal(exported.some((k) => /markPaid|simulate|fakePayout/i.test(k)), false);
});
