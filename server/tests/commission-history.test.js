// Commission and "paid vs owed" safety, through the real payment pipeline (real Express + PostgreSQL + a recording Razorpay
// test double; no network, no live Razorpay). Shows that:
//   * the default commission is 10%;
//   * each settlement keeps the rate that applied when the customer paid, so changing the configured rate later never
//     rewrites history (not at completion, not when a refund recalculates it, not in the finance dashboard);
//   * under PAYOUT_MODE=LEDGER_ONLY no worker amount is ever recorded or reported as transferred or paid.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_commission001';
process.env.RAZORPAY_KEY_SECRET = 'commission_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'commission_webhook_secret';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';
process.env.PLATFORM_FEE_PERCENT = '0'; process.env.PLATFORM_FEE_TAX_PERCENT = '0'; process.env.CUSTOMER_CANCELLATION_FEE_PERCENT = '0';
delete process.env.WORKER_COMMISSION_PERCENT; delete process.env.PAYOUT_MODE;

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { setRazorpayInstance } = require('../config/razorpay');
const pricing = require('../services/pricing');
const { server } = require('../server');
const { FakeRazorpay, checkoutSignature } = require('./helpers/fakeRazorpay');

const tag = `cm${Date.now()}`;
const created = [];
const gw = new FakeRazorpay();
let base; let plumber; let seq = 0;

const api = async (method, path, { token, json } = {}) => {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  let body; if (json !== undefined && method !== 'GET') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + path, { method, headers, body }); let data = null; try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
};
const makeUser = async (label, role) => {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null } });
  created.push(user.id); return { user, token: signSessionToken(user) };
};
const makeWorker = async (label) => {
  const w = await makeUser(label, 'WORKER');
  await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus: 'VERIFIED', hourlyRate: 300, bio: 'Pro' } });
  return w;
};
const makeBooking = (c, w, status = 'IN_PROGRESS', price = 1000) => prisma.booking.create({
  data: { bookingNumber: `BK-${tag}-${++seq}`, customerId: c.user.id, workerId: w.user.id, status, agreedPrice: price, scheduledAt: new Date(Date.now() + 86400000), priceConfirmedAt: new Date(), problemDescription: 'Fix tap' }
});
const pay = async (c, b) => {
  const o = await api('POST', `/api/payments/booking/${b.id}/order`, { token: c.token });
  assert.ok([200, 201].includes(o.status), JSON.stringify(o.data));
  const ent = gw.pay(o.data.orderId);
  const v = await api('POST', `/api/payments/booking/${b.id}/verify`, { token: c.token, json: { razorpay_order_id: o.data.orderId, razorpay_payment_id: ent.id, razorpay_signature: checkoutSignature(process.env.RAZORPAY_KEY_SECRET, o.data.orderId, ent.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
};
const settlementOf = (b) => prisma.workerSettlement.findFirst({ where: { bookingId: b.id } });
const n = (x) => Number(x);

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  setRazorpayInstance(gw);
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  const q = { where: { OR: [{ customerId: { in: created } }, { workerId: { in: created } }] } };
  const pays = (await prisma.payment.findMany({ ...q, select: { id: true } })).map((p) => p.id);
  const bookings = (await prisma.booking.findMany({ ...q, select: { id: true } })).map((b) => b.id);
  const step = (p) => p.catch((e) => console.error('cleanup:', e.message));
  await step(prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: pays } } })); await step(prisma.paymentRefund.deleteMany({ where: { paymentId: { in: pays } } }));
  await step(prisma.workerSettlement.deleteMany({ where: { paymentId: { in: pays } } })); await step(prisma.payment.deleteMany({ where: { id: { in: pays } } }));
  await step(prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: created } }, { entityId: { in: [...pays, ...created] } }] } }));
  await step(prisma.notification.deleteMany({ where: { userId: { in: created } } })); await step(prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookings } } }));
  await step(prisma.booking.deleteMany({ where: { id: { in: bookings } } })); await step(prisma.user.deleteMany({ where: { id: { in: created } } }));
  delete process.env.WORKER_COMMISSION_PERCENT; setRazorpayInstance(null);
  require('../services/trackingService').stopSweeper();
  await new Promise((r) => server.close(r)); await prisma.$disconnect();
});

test('the default worker commission is 10%, and bad values never silently become something else', () => {
  assert.equal(pricing.getRates().workerCommissionPercent, 10);
  const b = pricing.computeBreakdown(1000);
  assert.equal(b.commissionPaise, 10000); assert.equal(b.workerNetPaise, 90000);
  for (const bad of ['150', '-5', 'ten', ' ']) { process.env.WORKER_COMMISSION_PERCENT = bad; assert.equal(pricing.getRates().workerCommissionPercent, 10, `"${bad}" falls back to the default, not to 0 or an arbitrary value`); }
  process.env.WORKER_COMMISSION_PERCENT = '0'; assert.equal(pricing.getRates().workerCommissionPercent, 0, 'an explicit 0 is respected');
  delete process.env.WORKER_COMMISSION_PERCENT;
});

test('a settlement keeps the commission rate in force when the customer paid, whatever is configured later', async () => {
  const admin = await makeUser('admin', 'ADMIN'); const customer = await makeUser('c', 'CUSTOMER'); const worker = await makeWorker('w');
  const A = await makeBooking(customer, worker); const B = await makeBooking(customer, worker);
  delete process.env.WORKER_COMMISSION_PERCENT;                       // default: 10%
  await pay(customer, A); await pay(customer, B);
  let sA = await settlementOf(A);
  assert.equal(n(sA.commissionRate), 10); assert.equal(n(sA.commission), 100); assert.equal(n(sA.netAmount), 900); assert.equal(sA.status, 'PENDING_COMPLETION');

  process.env.WORKER_COMMISSION_PERCENT = '25';                       // the business changes the rate afterwards
  const C = await makeBooking(customer, worker); await pay(customer, C);
  const sC = await settlementOf(C);
  assert.equal(n(sC.commissionRate), 25); assert.equal(n(sC.commission), 250); assert.equal(n(sC.netAmount), 750, 'new payments use the new rate');
  assert.equal(n((await settlementOf(B)).commissionRate), 10, 'payments made before the change are untouched');

  // completing A under the new configuration does not re-price it
  assert.equal((await api('PUT', `/api/bookings/${A.id}/status`, { token: worker.token, json: { status: 'AWAITING_CUSTOMER_CONFIRMATION' } })).status, 200);
  assert.equal((await api('POST', `/api/payments/booking/${A.id}/confirm-completion`, { token: customer.token })).status, 200);
  sA = await settlementOf(A);
  assert.equal(n(sA.commissionRate), 10); assert.equal(n(sA.commission), 100); assert.equal(n(sA.netAmount), 900);
  assert.equal(sA.status, 'ELIGIBLE', 'LEDGER_ONLY: owed to the professional, not paid');

  // a partial refund recalculates with the STORED rate (10%), not the configured one (25%)
  const payA = await prisma.payment.findUnique({ where: { bookingId: A.id } });
  const refund = await api('POST', `/api/admin/payments/${payA.id}/refund`, { token: admin.token, json: { amount: 200, reason: 'Goodwill refund for a partial job' } });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  sA = await settlementOf(A);
  assert.equal(n(sA.commissionRate), 10); assert.equal(n(sA.commission), 80, '10% of the remaining 800, not 25%'); assert.equal(n(sA.netAmount), 720);
  assert.equal(n(sA.refundAdjustment), 200 - 20, 'the worker bears 180 of the 200 refund; LocalHire returns its 20 commission share');

  // the finance dashboard reports the stored commission (earned), and the CURRENT configuration separately
  const fin = (await api('GET', '/api/admin/finance/summary', { token: admin.token })).data.finance;
  assert.equal(fin.commission.configuredRatePercent, 25, 'configured rate is today\'s setting');
  const mine = await prisma.workerSettlement.findMany({ where: { workerId: worker.user.id } });
  const expectedEarned = mine.filter((s) => ['ELIGIBLE', 'PAYOUT_PROCESSING', 'PAID'].includes(s.status)).reduce((a, s) => a + n(s.commission), 0);
  assert.equal(expectedEarned, 80, 'only A is confirmed; B and C are still pending');
  assert.ok(fin.commission.pending >= 100 + 250, 'pending commission uses each settlement\'s own stored rate (B: 100, C: 250)');
  delete process.env.WORKER_COMMISSION_PERCENT;
});

test('LEDGER_ONLY never records, reports or implies a worker payment', async () => {
  const admin = await makeUser('admin2', 'ADMIN'); const customer = await makeUser('c2', 'CUSTOMER'); const worker = await makeWorker('w2');
  const b = await makeBooking(customer, worker); await pay(customer, b);
  await api('PUT', `/api/bookings/${b.id}/status`, { token: worker.token, json: { status: 'AWAITING_CUSTOMER_CONFIRMATION' } });
  const done = await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: customer.token });
  assert.equal(done.status, 200);
  const s = await settlementOf(b);
  assert.equal(s.status, 'ELIGIBLE'); assert.ok(!s.gatewayTransferId && !s.paidAt && !s.payoutRail && !s.transferStatus, 'no transfer id, rail, status or paid timestamp exists');
  const pid = (await prisma.payment.findUnique({ where: { bookingId: b.id } })).id;
  const kinds = (await prisma.paymentTransaction.findMany({ where: { paymentId: pid } })).map((t) => t.type);
  assert.ok(kinds.includes('COMPLETION_CONFIRMED')); assert.ok(!kinds.some((t) => /^TRANSFER_/.test(t)), `no transfer ledger entries: ${kinds}`);
  assert.equal(await prisma.workerSettlement.count({ where: { workerId: worker.user.id, status: { in: ['PAID', 'PAYOUT_PROCESSING'] } } }), 0);
  const fin = (await api('GET', '/api/admin/finance/summary', { token: admin.token })).data.finance;
  assert.equal(fin.payouts.mode, 'LEDGER_ONLY'); assert.equal(fin.payouts.railActive, false); assert.match(fin.payouts.note, /external|approved/i);
  assert.ok(fin.workers.owedNotYetTransferred >= 900, 'owed, not transferred'); assert.equal(fin.workers.actualPayoutsCompleted, 0, 'nothing is shown as paid out');
  // the professional's own earnings screen says "available balance", never "paid"
  const earn = (await api('GET', '/api/worker/earnings', { token: worker.token })).data;
  const text = JSON.stringify(earn);
  assert.equal(earn.payoutRail, 'NONE', 'no payout rail is active');
  assert.equal(earn.summary.paidOut, 0, 'nothing is shown as paid out');
  assert.equal(earn.summary.payoutProcessing, 0);
  assert.equal(earn.summary.availableBalance, 900, 'the confirmed amount is shown as an available balance owed to the professional');
  assert.ok(earn.settlements.every((x) => x.status !== 'PAID'), text.slice(0, 200));
  // there is no admin path that marks a settlement paid without provider confirmation
  const retry = await api('POST', `/api/admin/settlements/${s.id}/retry`, { token: admin.token, json: {} });
  assert.ok([400, 409, 422, 503].includes(retry.status), `retrying a payout without Route must be refused, got ${retry.status}`);
  assert.notEqual((await settlementOf(b)).status, 'PAID');
});
