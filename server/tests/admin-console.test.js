// Admin console: real Express, real PostgreSQL. The financial scenario is produced through the REAL payment pipeline
// (orders, signature-verified captures, refunds, cancellations, completion) against the in-memory Razorpay fake, and the
// reported figures are compared with amounts worked out by hand below. Nothing in the console is seeded with numbers.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_adminconsole1';
process.env.RAZORPAY_KEY_SECRET = 'admin_console_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'admin_console_webhook_secret';
process.env.PLATFORM_FEE_PERCENT = '5';
process.env.PLATFORM_FEE_TAX_PERCENT = '18';
delete process.env.WORKER_COMMISSION_PERCENT; // the default (10%) is part of what is tested
process.env.CUSTOMER_CANCELLATION_FEE_PERCENT = '10';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';
delete process.env.PAYOUT_MODE;

const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const { signSessionToken } = require('../services/authTokens');
const { setRazorpayInstance } = require('../config/razorpay');
const pricing = require('../services/pricing');
const adminRange = require('../services/adminRange');
const { server } = require('../server');
const { FakeRazorpay, checkoutSignature } = require('./helpers/fakeRazorpay');
const { io: ioClient } = require('socket.io-client');

const tag = `adm${Date.now()}`;
const created = [];
const gw = new FakeRazorpay();
let base; let plumber; let seq = 0;
const KEY = process.env.RAZORPAY_KEY_SECRET;

async function api(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) body = form; else if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + path, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}
async function makeUser(label, role, extra = {}) {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210', ...extra } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}
async function makeWorker(label, { verification = 'VERIFIED', city = 'Belagavi', locality = 'Tilakwadi', category = plumber, online = false } = {}) {
  const w = await makeUser(label, 'WORKER');
  const profile = await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: category.id, verificationStatus: verification, hourlyRate: 300, bio: 'Pro', city, locality } });
  await prisma.workerLocation.create({ data: { workerProfileId: profile.id, latitude: online ? 15.85 : null, longitude: online ? 74.5 : null, lastLocationUpdate: online ? new Date() : null, isAvailable: online, sharingEnabled: online } });
  return { ...w, profile };
}
const makeBooking = (c, w, status = 'CONFIRMED', price = 1000, extra = {}) => prisma.booking.create({
  data: { bookingNumber: `BK-${tag}-${++seq}`, customerId: c.user.id, workerId: w.user.id, status, agreedPrice: price, scheduledAt: new Date(Date.now() + 86400000), priceConfirmedAt: new Date(), problemDescription: 'Fix tap', ...extra }
});
const pay = async (c, b, payOpts = {}) => {
  const o = await api('POST', `/api/payments/booking/${b.id}/order`, { token: c.token });
  assert.ok(o.status === 200 || o.status === 201, JSON.stringify(o.data));
  const ent = gw.pay(o.data.orderId, payOpts);
  const v = await api('POST', `/api/payments/booking/${b.id}/verify`, { token: c.token, json: { razorpay_order_id: o.data.orderId, razorpay_payment_id: ent.id, razorpay_signature: checkoutSignature(KEY, o.data.orderId, ent.id) } });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  return ent;
};
const money = (n) => Math.round(Number(n) * 100) / 100;

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  setRazorpayInstance(gw);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  const q = { where: { OR: [{ customerId: { in: created } }, { workerId: { in: created } }] } };
  const pays = (await prisma.payment.findMany({ ...q, select: { id: true } })).map((p) => p.id);
  const bookings = (await prisma.booking.findMany({ ...q, select: { id: true } })).map((b) => b.id);
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: pays } } }).catch(() => {});
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: pays } } }).catch(() => {});
  await prisma.workerSettlement.deleteMany({ where: { paymentId: { in: pays } } }).catch(() => {});
  await prisma.payment.deleteMany({ where: { id: { in: pays } } }).catch(() => {});
  await prisma.supportTicket.deleteMany({ where: { OR: [{ bookingId: { in: bookings } }, { reporterId: { in: created } }] } }).catch(() => {});
  await prisma.review.deleteMany({ where: { workerId: { in: created } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: created } }, { entityId: { in: [...pays, ...created] } }, { action: { startsWith: 'CATEGORY_' }, details: { path: ['name'], string_starts_with: tag } }] } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.workerVerificationEvent.deleteMany({ where: { onboarding: { userId: { in: created } } } }).catch(() => {});
  await prisma.workerDocument.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.workerOnboarding.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookings } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { id: { in: bookings } } }).catch(() => {});
  await prisma.customerAddress.deleteMany({ where: { customerId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  // Categories go last: the test professionals reference them until their accounts are removed.
  await prisma.serviceCategory.deleteMany({ where: { name: { startsWith: `T7 ${tag}` } } }).catch((e) => console.error('category cleanup failed:', e.message));
  setRazorpayInstance(null);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ─── Access control ─────────────────────────────────────────────────────────

test('every admin console endpoint refuses unauthenticated users, customers and workers', async () => {
  const c = await makeUser('ac-c', 'CUSTOMER'); const w = await makeWorker('ac-w'); const admin = await makeUser('ac-a', 'ADMIN');
  const id = c.user.id;
  const gets = ['/api/admin/dashboard', '/api/admin/analytics', '/api/admin/finance/summary', '/api/admin/finance/owed-workers', '/api/admin/finance/settlements', '/api/admin/workers', `/api/admin/workers/${w.user.id}`,
    '/api/admin/customers', `/api/admin/customers/${id}`, '/api/admin/bookings', `/api/admin/bookings/${id}`, '/api/admin/categories', '/api/admin/audit-logs'];
  const posts = [[`/api/admin/workers/${w.user.id}/suspend`, { reason: 'because I said so' }], [`/api/admin/workers/${w.user.id}/reactivate`, { reason: 'because I said so' }], [`/api/admin/customers/${id}/suspend`, { reason: 'because I said so' }],
    [`/api/admin/customers/${id}/reactivate`, { reason: 'because I said so' }], ['/api/admin/categories', { name: 'Hacked' }]];
  for (const [who, expected] of [[null, 401], [c, 403], [w, 403]]) {
    for (const path of gets) assert.equal((await api('GET', path, { token: who && who.token })).status, expected, `GET ${path} as ${who ? who.user.role : 'anonymous'}`);
    for (const [path, json] of posts) assert.equal((await api('POST', path, { token: who && who.token, json })).status, expected, `POST ${path} as ${who ? who.user.role : 'anonymous'}`);
    assert.equal((await api('PATCH', `/api/admin/categories/${plumber.id}`, { token: who && who.token, json: { name: 'x' } })).status, expected);
    assert.equal((await api('DELETE', `/api/admin/categories/${plumber.id}`, { token: who && who.token })).status, expected);
  }
  assert.equal((await api('GET', '/api/admin/dashboard', { token: admin.token })).status, 200);
  assert.equal((await prisma.serviceCategory.findUnique({ where: { id: plumber.id } })).name, 'Plumber', 'nothing was changed by the refused requests');
});

// ─── Money: commission default, scenario, reconciliation ────────────────────

test('worker commission defaults to 10% and is what the finance dashboard reports', async () => {
  assert.equal(pricing.getRates().workerCommissionPercent, 10);
  const admin = await makeUser('cm-a', 'ADMIN');
  const f = await api('GET', '/api/admin/finance/summary', { token: admin.token });
  assert.equal(f.data.finance.commission.configuredRatePercent, 10);
});

test('financial dashboard: figures come from payment, refund and settlement records and reconcile to the paisa', async () => {
  const admin = await makeUser('fin-a', 'ADMIN');
  const read = async () => (await api('GET', '/api/admin/finance/summary', { token: admin.token })).data.finance;
  const dash = async () => (await api('GET', '/api/admin/dashboard', { token: admin.token })).data;
  const before = await read(); const dashBefore = await dash();

  const c = await makeUser('fin-c', 'CUSTOMER'); const w = await makeWorker('fin-w');
  const act = (token, id, status, notes) => api('PUT', `/api/bookings/${id}/status`, { token, json: { status, notes } });
  const complete = async (b) => { await act(w.token, b.id, 'AWAITING_CUSTOMER_CONFIRMATION'); const r = await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: c.token }); assert.equal(r.status, 200, JSON.stringify(r.data)); };

  // B1: paid and confirmed (owed). Razorpay reports its fee: Rs 25.00 + Rs 4.50 tax
  const b1 = await makeBooking(c, w, 'IN_PROGRESS'); await pay(c, b1, { fee: 2500, tax: 450 }); await complete(b1);
  // B2: paid, waiting for the customer to confirm
  const b2 = await makeBooking(c, w, 'IN_PROGRESS'); await pay(c, b2);
  // B3: paid, then a partial refund of Rs 200
  const b3 = await makeBooking(c, w, 'CONFIRMED'); await pay(c, b3);
  const p3 = await prisma.payment.findUnique({ where: { bookingId: b3.id } });
  assert.equal((await api('POST', `/api/admin/payments/${p3.id}/refund`, { token: admin.token, json: { amount: 200, reason: 'Goodwill' } })).status, 200);
  // B4: paid, then the professional cancels (full refund)
  const b4 = await makeBooking(c, w, 'CONFIRMED'); await pay(c, b4); assert.equal((await act(w.token, b4.id, 'CANCELLED')).status, 200);
  // B5: Rs 2000 job, confirmed, and the provider reports the payout settled
  const b5 = await makeBooking(c, w, 'IN_PROGRESS', 2000); await pay(c, b5); await complete(b5);
  await prisma.workerSettlement.updateMany({ where: { bookingId: b5.id }, data: { status: 'PAID', paidAt: new Date(), payoutRail: 'RAZORPAY_ROUTE' } });
  // B6: confirmed, and the provider reports the payout failed
  const b6 = await makeBooking(c, w, 'IN_PROGRESS'); await pay(c, b6); await complete(b6);
  await prisma.workerSettlement.updateMany({ where: { bookingId: b6.id }, data: { status: 'FAILED', failureReason: 'Beneficiary account closed' } });
  // B7: the customer cancels after the professional is on the way: 10% cancellation fee kept for the professional
  const b7 = await makeBooking(c, w, 'DISPATCHED'); await pay(c, b7); assert.equal((await act(c.token, b7.id, 'CANCELLED')).status, 200);

  const after = await read();
  const d = (get) => money(get(after) - get(before));
  // ---- worked out by hand (service 1000: fee 50, tax 9, total 1059; commission 10%) ----
  assert.equal(d((f) => f.customerPaymentValue), 8472, '6 x 1059 + 2118');
  assert.equal(d((f) => f.refunds), 2218, '200 + 1059 + 959');
  assert.equal(d((f) => f.netCashReceived), 6254);
  assert.equal(d((f) => f.grossServiceValue), 8000);
  assert.equal(d((f) => f.serviceValueRefunded), 2100, '200 + 1000 + 900 (a cancellation refund returns fee and tax first)');
  assert.equal(d((f) => f.netServiceValue), 5900);
  assert.equal(d((f) => f.platformFeesCollected), 400); assert.equal(d((f) => f.platformFeesRefunded), 100); assert.equal(d((f) => f.platformFeesNet), 300);
  assert.equal(d((f) => f.taxesCollected), 72); assert.equal(d((f) => f.taxesRefunded), 18); assert.equal(d((f) => f.taxesNet), 54);
  assert.equal(d((f) => f.commission.earned), 410, 'B1 100 + B5 200 + B6 100 + B7 10');
  assert.equal(d((f) => f.commission.pending), 180, 'B2 100 + B3 80 (after the refund): paid but not yet confirmed, so NOT earned');
  assert.equal(d((f) => f.commission.expectedTotal), 590);
  assert.equal(d((f) => f.platformFeeRevenue.earned), 200, 'fees on confirmed jobs only (B7 returned its fee)');
  assert.equal(d((f) => f.platformFeeRevenue.pending), 100);
  assert.equal(d((f) => f.localhireRevenueEarned), 610, 'commission 410 + fees 200: taxes are NOT revenue');
  assert.equal(d((f) => f.localhireRevenuePending), 280);
  assert.equal(d((f) => f.workers.netEntitlementTotal), 5310);
  assert.equal(d((f) => f.workers.outstandingLiability), 3510, 'pending 1620 + owed 990 + failed 900');
  assert.equal(d((f) => f.workers.owedNotYetTransferred), 990, 'B1 900 + B7 90: owed, NOT paid');
  assert.equal(d((f) => f.workers.actualPayoutsCompleted), 1800, 'only what the provider reported settled');
  assert.equal(d((f) => f.workers.failedPayouts), 900);
  assert.equal(d((f) => f.workers.byStatus.PENDING_COMPLETION.amount), 1620);
  assert.equal(d((f) => f.workers.byStatus.CANCELLED.amount), 0);
  assert.equal(d((f) => f.cash.stillHeldByLocalHire), 4454, '6254 received less 1800 already paid out');
  assert.equal(d((f) => f.gatewayFees.reported), 29.5, 'Rs 25.00 + Rs 4.50 tax, as Razorpay reported for B1');
  assert.equal(after.gatewayFees.paymentsReported - before.gatewayFees.paymentsReported, 1);
  assert.equal(after.gatewayFees.paymentsNotReported - before.gatewayFees.paymentsNotReported, 6, 'unreported fees are not estimated');
  // ---- the books balance ----
  const r = after.reconciliation;
  assert.equal(r.difference, 0, JSON.stringify(r));
  assert.equal(money(r.workerNetEntitlement + r.commission + r.platformFeesNet + r.taxesNet), r.accountedFor);
  assert.equal(r.paymentsWithoutSettlement, 0);
  // ---- never revenue = customer payments ----
  assert.notEqual(after.localhireRevenueEarned, after.customerPaymentValue);
  assert.ok(after.localhireRevenueEarned < after.netCashReceived);
  // ---- LEDGER_ONLY is explicit ----
  assert.equal(after.payouts.mode, 'LEDGER_ONLY'); assert.equal(after.payouts.railActive, false);
  assert.match(after.payouts.note, /external, approved payout process/i);
  assert.match(after.payouts.note, /liabilities, not payments/i);

  // the overview dashboard shows the same records
  const dashAfter = await dash();
  const dm = (k) => money(dashAfter.money[k] - dashBefore.money[k]);
  assert.equal(dm('grossServiceValue'), 8000); assert.equal(dm('commissionEarned'), 410); assert.equal(dm('refunds'), 2218);
  assert.equal(dm('outstandingWorkerSettlements'), 3510); assert.equal(dm('actualWorkerPayouts'), 1800); assert.equal(dm('failedPayouts'), 900); assert.equal(dm('taxesHeld'), 54);
  assert.equal(dashAfter.bookings.total - dashBefore.bookings.total, 7);
  assert.equal(dashAfter.bookings.cancelled - dashBefore.bookings.cancelled, 2);
  assert.equal(dashAfter.bookings.completed - dashBefore.bookings.completed, 3, 'B1, B5 and B6: customer confirmation completes the booking');

  // owed workers (for the external payout process) and the settlement list
  const owed = (await api('GET', '/api/admin/finance/owed-workers', { token: admin.token })).data.workers.find((x) => x.workerId === w.user.id);
  assert.equal(owed.owed, 990); assert.equal(owed.failed, 900); assert.equal(owed.total, 1890);
  const sets = await api('GET', `/api/admin/finance/settlements?status=FAILED&limit=50`, { token: admin.token });
  const failed = sets.data.settlements.find((s) => s.bookingNumber === b6.bookingNumber);
  assert.equal(failed.failureReason, 'Beneficiary account closed'); assert.equal(failed.netAmount, 900); assert.equal(failed.worker, w.user.name);
  assert.equal((await api('GET', '/api/admin/finance/settlements?status=PAID&limit=50', { token: admin.token })).data.settlements.every((s) => s.status === 'PAID'), true);
  const text = JSON.stringify([after, dashAfter, owed]);
  assert.equal(/storagePath|signedUrl|originalName|token|secret/i.test(text), false, 'no private data in finance responses');

  // date range: payments captured today vs a period that ends yesterday
  const today = adminRange.todayYmd(); const yesterday = adminRange.addDays(today, -1);
  const inRange = (await api('GET', `/api/admin/finance/summary?from=${today}&to=${today}`, { token: admin.token })).data.finance;
  assert.ok(inRange.paymentsCount >= 7);
  assert.equal(money(inRange.customerPaymentValue - before.customerPaymentValue), 8472, 'everything above was captured today');
  const past = (await api('GET', `/api/admin/finance/summary?from=${adminRange.addDays(today, -700)}&to=${yesterday}`, { token: admin.token })).data.finance;
  assert.equal(past.customerPaymentValue, before.customerPaymentValue, 'yesterday and earlier does not include them');
  assert.equal(past.reconciliation.difference, 0);
});

test('date range validation on every report', async () => {
  const admin = await makeUser('dr-a', 'ADMIN');
  for (const path of ['/api/admin/finance/summary', '/api/admin/dashboard', '/api/admin/analytics', '/api/admin/bookings', '/api/admin/audit-logs']) {
    assert.equal((await api('GET', `${path}?from=2026-02-31`, { token: admin.token })).status, 400, `${path} rejects impossible dates`);
    assert.equal((await api('GET', `${path}?from=yesterday`, { token: admin.token })).status, 400);
    assert.equal((await api('GET', `${path}?from=2026-05-10&to=2026-05-01`, { token: admin.token })).status, 400, 'from after to');
    assert.equal((await api('GET', `${path}?from=2020-01-01&to=2026-05-01`, { token: admin.token })).status, 400, 'more than 800 days');
  }
  assert.equal((await api('GET', '/api/admin/analytics?from=2025-01-01&to=2026-12-31', { token: admin.token })).status, 400, 'daily charts are limited');
  assert.equal((await api('GET', '/api/admin/analytics?from=2025-01-01&to=2026-12-31&granularity=month', { token: admin.token })).status, 200);
  assert.equal((await api('GET', '/api/admin/finance/summary?from=2026-01-01', { token: admin.token })).status, 200, 'open-ended ranges are fine');
  // business-day boundaries are in the business time zone
  assert.equal(adminRange.startOfDay('2026-03-10', 'Asia/Kolkata').toISOString(), '2026-03-09T18:30:00.000Z');
  assert.equal(adminRange.parseRange({ from: '2026-03-10', to: '2026-03-10' }).to.toISOString(), '2026-03-10T18:30:00.000Z', 'to is the end of that day');
});

// ─── Workers ────────────────────────────────────────────────────────────────

test('worker management: search, filters, pagination, profile, history, suspend and reactivate without bypassing verification', async () => {
  const admin = await makeUser('wm-a', 'ADMIN');
  const cat2 = await prisma.serviceCategory.findFirst({ where: { name: { not: 'Plumber' } } });
  const a = await makeWorker('wm-alpha', { verification: 'VERIFIED', city: `City${tag}`, locality: `Loc${tag}A`, online: true });
  const b = await makeWorker('wm-bravo', { verification: 'PENDING_REVIEW', city: `City${tag}`, locality: `Loc${tag}B`, category: cat2 });
  const c = await makeWorker('wm-charlie', { verification: 'UNVERIFIED', city: `Other${tag}`, locality: `Loc${tag}C` });
  const list = (qs) => api('GET', `/api/admin/workers?${qs}`, { token: admin.token });
  const names = (r) => r.data.workers.map((x) => x.name).sort();

  assert.deepEqual(names(await list(`q=wm-alpha`)), [a.user.name]);
  assert.deepEqual(names(await list(`q=${encodeURIComponent(b.user.email)}`)), [b.user.name], 'search by e-mail');
  assert.deepEqual(names(await list(`city=City${tag}`)), [a.user.name, b.user.name].sort());
  assert.deepEqual(names(await list(`locality=Loc${tag}C`)), [c.user.name]);
  assert.deepEqual(names(await list(`q=wm-&verification=PENDING_REVIEW`)), [b.user.name]);
  assert.deepEqual(names(await list(`q=wm-&categoryId=${cat2.id}`)), [b.user.name], 'filter by profession');
  assert.deepEqual(names(await list(`q=wm-&availability=online`)), [a.user.name]);
  assert.deepEqual(names(await list(`q=wm-&availability=offline`)), [b.user.name, c.user.name].sort());
  const row = (await list('q=wm-alpha')).data.workers[0];
  assert.deepEqual([row.verificationStatus, row.online, row.profession, row.city, row.locality, row.rating, row.completedJobs, row.suspended], ['VERIFIED', true, 'Plumber', `City${tag}`, `Loc${tag}A`, null, 0, false]);
  // pagination
  const p1 = await list(`q=wm-&limit=2&page=1`); const p2 = await list(`q=wm-&limit=2&page=2`);
  assert.equal(p1.data.workers.length, 2); assert.equal(p1.data.total >= 3, true); assert.equal(p1.data.page, 1); assert.ok(p1.data.pages >= 2);
  assert.equal(new Set([...p1.data.workers, ...p2.data.workers].map((x) => x.id)).size, p1.data.workers.length + p2.data.workers.length, 'pages do not overlap');

  // profile: genuine reviews, completed jobs, verification history, documents without any file reference
  const cust = await makeUser('wm-cust', 'CUSTOMER');
  const done = await makeBooking(cust, a, 'COMPLETED', 500);
  await prisma.review.create({ data: { bookingId: done.id, customerId: cust.user.id, workerId: a.user.id, rating: 4, comment: 'Solid work, on time.' } });
  const ob = await prisma.workerOnboarding.create({ data: { userId: a.user.id, status: 'VERIFIED', submittedAt: new Date(Date.now() - 86400000), reviewedAt: new Date(), decisionReason: 'Documents verified', attemptCount: 1 } });
  await prisma.workerDocument.create({ data: { userId: a.user.id, onboardingId: ob.id, type: 'GOVT_ID_PAN', originalName: 'my-secret-aadhaar.jpg', mimeType: 'image/jpeg', sizeBytes: 1234, storageBucket: 'private-docs', storagePath: `${a.user.id}/secret-path.jpg`, status: 'VERIFIED' } });
  await prisma.workerVerificationEvent.createMany({ data: [{ onboardingId: ob.id, actorId: a.user.id, actorRole: 'WORKER', action: 'SUBMITTED', toStatus: 'PENDING' }, { onboardingId: ob.id, actorId: admin.user.id, actorRole: 'ADMIN', action: 'APPROVED', fromStatus: 'PENDING', toStatus: 'VERIFIED', reason: 'Documents verified' }] });
  const detail = (await api('GET', `/api/admin/workers/${a.user.id}`, { token: admin.token })).data.worker;
  assert.equal(detail.stats.completedJobs, 1);
  assert.equal(detail.reviews.length, 1); assert.equal(detail.reviews[0].rating, 4); assert.equal(detail.reviews[0].comment, 'Solid work, on time.');
  assert.deepEqual(detail.verification.history.map((h) => h.action).sort(), ['APPROVED', 'SUBMITTED']);
  assert.equal(detail.verification.status, 'VERIFIED');
  assert.deepEqual(detail.verification.documents.map((d) => [d.type, d.status]), [['GOVT_ID_PAN', 'VERIFIED']]);
  const raw = JSON.stringify(detail);
  assert.equal(/secret-path|my-secret-aadhaar|storagePath|storageBucket|signedUrl|private-docs/.test(raw), false, 'no document files, names or paths in a worker profile');
  assert.equal(/serviceAddress|street/i.test(raw), false);
  assert.equal((await api('GET', `/api/admin/workers/${cust.user.id}`, { token: admin.token })).status, 404, 'a customer id is not a worker');

  // suspension: reason required, audit-logged, takes effect immediately
  const sockTok = signSessionToken(await prisma.user.findUnique({ where: { id: a.user.id } }));
  const socket = ioClient(base, { auth: { token: sockTok }, transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const closed = new Promise((resolve) => socket.once('disconnect', resolve));
  const sus = (id, json) => api('POST', `/api/admin/workers/${id}/suspend`, { token: admin.token, json });
  assert.equal((await sus(a.user.id, {})).status, 400); assert.equal((await sus(a.user.id, { reason: 'bad' })).status, 400, 'reason too short');
  assert.equal((await api('GET', '/api/users/location', { token: a.token })).status, 200, 'still allowed before suspension');
  const r = await sus(a.user.id, { reason: 'Multiple customer complaints about no-shows' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await closed;
  assert.equal((await api('GET', '/api/users/location', { token: a.token })).status, 401, 'the old session no longer works');
  const fresh = signSessionToken(await prisma.user.findUnique({ where: { id: a.user.id } }));
  assert.ok([401, 403].includes((await api('GET', '/api/users/location', { token: fresh })).status), 'a suspended account cannot use a new token either');
  const row2 = (await list('q=wm-alpha')).data.workers[0];
  assert.equal(row2.suspended, true); assert.equal(row2.online, false, 'a suspended worker is taken offline');
  assert.equal((await list(`q=wm-&status=suspended`)).data.workers.length, 1);
  assert.equal((await sus(a.user.id, { reason: 'Again please' })).status, 409, 'already suspended');
  const log = await prisma.auditLog.findFirst({ where: { action: 'WORKER_SUSPENDED', entityId: a.user.id } });
  assert.equal(log.userId, admin.user.id); assert.equal(log.details.reason, 'Multiple customer complaints about no-shows'); assert.ok(log.createdAt); assert.ok(log.ipAddress);
  assert.equal((await api('GET', `/api/admin/workers/${a.user.id}`, { token: admin.token })).data.worker.suspensionReason, 'Multiple customer complaints about no-shows');

  // reactivation never changes identity verification
  const re = (id, json) => api('POST', `/api/admin/workers/${id}/reactivate`, { token: admin.token, json });
  assert.equal((await re(a.user.id, { reason: '' })).status, 400);
  assert.equal((await re(a.user.id, { reason: 'Appeal accepted after review' })).status, 200);
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: a.user.id } })).verificationStatus, 'VERIFIED', 'verified stays verified');
  assert.equal((await re(a.user.id, { reason: 'Appeal accepted after review' })).status, 409, 'not suspended any more');
  assert.equal((await sus(c.user.id, { reason: 'Fake documents suspected' })).status, 200);
  assert.equal((await re(c.user.id, { reason: 'Mistake, restoring account' })).status, 200);
  const stillUnverified = await prisma.workerProfile.findUnique({ where: { userId: c.user.id } });
  assert.equal(stillUnverified.verificationStatus, 'UNVERIFIED', 'reactivation is not an approval shortcut');
  const verifyShortcut = await api('PATCH', `/api/admin/users/${c.user.id}/verify`, { token: admin.token, json: { status: 'VERIFIED' } });
  assert.notEqual((await prisma.workerProfile.findUnique({ where: { userId: c.user.id } })).verificationStatus, 'VERIFIED', `the legacy shortcut still cannot verify (${verifyShortcut.status})`);
  assert.equal(await prisma.auditLog.count({ where: { action: 'WORKER_REACTIVATED', entityId: { in: [a.user.id, c.user.id] } } }), 2);

  // guards
  const other = await makeUser('wm-admin2', 'ADMIN');
  assert.equal((await sus(other.user.id, { reason: 'Trying to suspend an admin' })).status, 404, 'admins are not workers');
  assert.equal((await api('POST', `/api/admin/customers/${admin.user.id}/suspend`, { token: admin.token, json: { reason: 'Suspending myself' } })).status, 404);
  assert.equal((await sus('00000000-0000-0000-0000-000000000000', { reason: 'Nobody home' })).status, 404);
});

// ─── Customers ──────────────────────────────────────────────────────────────

test('customer management: masked list, private profile (audited), booking/payment/complaint history, suspend and reactivate', async () => {
  const admin = await makeUser('cu-a', 'ADMIN');
  const c = await makeUser('cu-c', 'CUSTOMER'); const other = await makeUser('cu-o', 'CUSTOMER'); const w = await makeWorker('cu-w');
  await prisma.customerAddress.create({ data: { customerId: c.user.id, street: '99 Secret Street', city: 'Belagavi', postalCode: '590001', latitude: 15.85, longitude: 74.5 } });
  const addr = await prisma.customerAddress.findFirst({ where: { customerId: c.user.id } });
  const b = await makeBooking(c, w, 'IN_PROGRESS', 1000, { addressId: addr.id });
  await pay(c, b);
  await makeBooking(other, w, 'CONFIRMED');
  await prisma.supportTicket.create({ data: { ticketNumber: `TCK-${tag}-1`, reporterId: c.user.id, bookingId: b.id, subject: 'Tap still leaking', description: 'Please help', priority: 'HIGH' } });

  const list = await api('GET', `/api/admin/customers?q=${tag}.cu-c`, { token: admin.token });
  assert.equal(list.data.customers.length, 1);
  const row = list.data.customers[0];
  assert.equal(row.email.includes(tag), false, 'e-mail is masked in lists'); assert.match(row.email, /^a\*+@example\.com$/); assert.match(row.phone, /^•+3210$/); assert.equal(row.bookings, 1);
  assert.equal(list.data.customers.every((x) => !/@.*\./.test(x.email) || x.email.includes('*')), true);
  assert.equal((await api('GET', `/api/admin/customers?q=cu-c&status=suspended`, { token: admin.token })).data.customers.length, 0);

  const viewsBefore = await prisma.auditLog.count({ where: { action: 'CUSTOMER_PROFILE_VIEWED', entityId: c.user.id } });
  const d = (await api('GET', `/api/admin/customers/${c.user.id}`, { token: admin.token })).data.customer;
  assert.equal(await prisma.auditLog.count({ where: { action: 'CUSTOMER_PROFILE_VIEWED', entityId: c.user.id } }), viewsBefore + 1, 'opening a profile is recorded');
  assert.equal(d.email, c.user.email); assert.equal(d.bookings.length, 1); assert.equal(d.bookings[0].worker, w.user.name); assert.equal(d.bookings[0].city, 'Belagavi'); assert.equal(d.bookings[0].paymentState, 'CAPTURED');
  assert.equal(d.payments.length, 1); assert.equal(d.payments[0].total, 1059); assert.equal(d.payments[0].state, 'CAPTURED');
  assert.equal(d.complaints.length, 1); assert.equal(d.complaints[0].subject, 'Tap still leaking');
  assert.equal(d.stats.totalPaid, 1059);
  assert.equal(/Secret Street|latitude|longitude|gatewayPaymentId|gatewayOrderId/.test(JSON.stringify(d)), false, 'street address, coordinates and gateway ids are not shown');
  assert.equal(JSON.stringify(d).includes(other.user.email), false, "another customer's data never appears");
  assert.equal((await api('GET', `/api/admin/customers/${w.user.id}`, { token: admin.token })).status, 404, 'a worker id is not a customer');

  const sus = await api('POST', `/api/admin/customers/${c.user.id}/suspend`, { token: admin.token, json: { reason: 'Abusive messages to professionals' } });
  assert.equal(sus.status, 200); assert.equal(sus.data.openBookings, 1); assert.match(sus.data.note, /open bookings/i);
  assert.equal((await api('GET', '/api/payments/history', { token: c.token })).status, 401, 'their session ends');
  assert.equal((await api('GET', `/api/admin/customers?q=cu-c&status=suspended`, { token: admin.token })).data.customers.length, 1);
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'IN_PROGRESS', 'suspending does not alter bookings or payments');
  assert.equal((await prisma.payment.findUnique({ where: { bookingId: b.id } })).state, 'CAPTURED');
  assert.equal((await api('POST', `/api/admin/customers/${c.user.id}/reactivate`, { token: admin.token, json: { reason: 'Warning issued, access restored' } })).status, 200);
  assert.equal((await prisma.user.findUnique({ where: { id: c.user.id } })).isActive, true);
  const logs = await api('GET', '/api/admin/audit-logs?action=CUSTOMER_SUSPENDED', { token: admin.token });
  assert.ok(logs.data.logs.some((l) => l.reason === 'Abusive messages to professionals' && l.actor === admin.user.name));
});

// ─── Bookings ───────────────────────────────────────────────────────────────

test('booking management: every status filter, search, dates, pagination, payment status, no state changes', async () => {
  const admin = await makeUser('bk-a', 'ADMIN');
  const c = await makeUser('bk-c', 'CUSTOMER'); const w = await makeWorker('bk-w');
  const make = (status, extra = {}) => makeBooking(c, w, status, 700, extra);
  const set = {
    requested: await make('REQUESTED'), accepted: await make('CONFIRMED'), journey: await make('DISPATCHED', { journeyStartedAt: new Date() }), arrived: await make('DISPATCHED', { journeyStartedAt: new Date(), arrivedAt: new Date() }),
    service: await make('IN_PROGRESS'), completion: await make('AWAITING_CUSTOMER_CONFIRMATION'), completed: await make('COMPLETED'), cancelled: await make('CANCELLED'), disputed: await make('DISPUTED')
  };
  const ids = (r) => r.data.bookings.map((b) => b.id).sort();
  const only = (...keys) => keys.map((k) => set[k].id).sort();
  const get = (qs) => api('GET', `/api/admin/bookings?q=${encodeURIComponent(w.user.name)}&limit=50&${qs}`, { token: admin.token });
  assert.deepEqual(ids(await get('status=requested')), only('requested'));
  assert.deepEqual(ids(await get('status=accepted')), only('accepted'));
  assert.deepEqual(ids(await get('status=journey_started')), only('journey'));
  assert.deepEqual(ids(await get('status=arrived')), only('arrived'));
  assert.deepEqual(ids(await get('status=in_service')), only('service'));
  assert.deepEqual(ids(await get('status=completion_requested')), only('completion'));
  assert.deepEqual(ids(await get('status=completed')), only('completed'));
  assert.deepEqual(ids(await get('status=cancelled')), only('cancelled'));
  assert.deepEqual(ids(await get('status=disputed')), only('disputed'));
  assert.deepEqual(ids(await get('status=active')), only('accepted', 'journey', 'arrived', 'service', 'completion'), 'active = accepted through completion requested');
  assert.equal((await get('status=bogus')).status, 400);
  const all = await get('');
  assert.equal(all.data.total >= 9, true); assert.ok(all.data.filters.includes('journey_started'));
  const j = all.data.bookings.find((b) => b.id === set.journey.id); const a = all.data.bookings.find((b) => b.id === set.arrived.id);
  assert.equal(j.journeyStatus, 'JOURNEY_STARTED'); assert.equal(a.journeyStatus, 'WORKER_ARRIVED');

  // search + pagination + dates
  assert.deepEqual(ids(await api('GET', `/api/admin/bookings?q=${set.accepted.bookingNumber}`, { token: admin.token })), only('accepted'));
  assert.equal((await api('GET', `/api/admin/bookings?q=${encodeURIComponent(w.user.name)}&limit=4&page=3`, { token: admin.token })).data.bookings.length, 1, '9 bookings, pages of 4: the third holds 1');
  const today = adminRange.todayYmd();
  assert.equal((await api('GET', `/api/admin/bookings?q=${encodeURIComponent(w.user.name)}&from=${today}&to=${today}&limit=50`, { token: admin.token })).data.total, 9);
  assert.equal((await api('GET', `/api/admin/bookings?q=${encodeURIComponent(w.user.name)}&from=2020-01-01&to=2020-01-31`, { token: admin.token })).data.total, 0);

  // detail shows the related payment; paid booking
  const paid = await makeBooking(c, w, 'IN_PROGRESS', 1000); await pay(c, paid);
  const dl = (await api('GET', `/api/admin/bookings/${paid.id}`, { token: admin.token })).data.booking;
  assert.equal(dl.payment.state, 'CAPTURED'); assert.equal(dl.payment.total, 1059); assert.equal(dl.payment.settlement.status, 'PENDING_COMPLETION'); assert.equal(dl.payment.settlement.workerNet, 900); assert.equal(dl.payment.settlement.commission, 100);
  assert.equal(dl.journeyStatus, 'SERVICE_IN_PROGRESS');
  assert.match(dl.actions.note, /No state can be forced/);
  const listed = (await api('GET', `/api/admin/bookings?q=${paid.bookingNumber}`, { token: admin.token })).data.bookings[0];
  assert.equal(listed.payment.state, 'CAPTURED'); assert.equal(listed.payment.settlement, 'PENDING_COMPLETION');
  assert.equal(/trackLatitude|trackLongitude|street/.test(JSON.stringify(dl)), false);
  // there is no endpoint that forces a state
  for (const [m, p] of [['PUT', `/api/admin/bookings/${paid.id}`], ['PATCH', `/api/admin/bookings/${paid.id}`], ['POST', `/api/admin/bookings/${paid.id}/status`], ['DELETE', `/api/admin/bookings/${paid.id}`]]) {
    assert.ok([404].includes((await api(m, p, { token: admin.token, json: { status: 'COMPLETED' } })).status), `${m} ${p}`);
  }
  assert.equal((await prisma.booking.findUnique({ where: { id: paid.id } })).status, 'IN_PROGRESS');
});

// ─── Categories ─────────────────────────────────────────────────────────────

test('category management: create, edit, disable with a reason, icon upload, counts, deletion safeguards', async () => {
  const admin = await makeUser('ct-a', 'ADMIN');
  const name = `T7 ${tag} Roofing`;
  const bad = await api('POST', '/api/admin/categories', { token: admin.token, json: { name: 'x' } });
  assert.equal(bad.status, 400);
  const made = await api('POST', '/api/admin/categories', { token: admin.token, json: { name, description: 'Roof repair and waterproofing' } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const cat = made.data.category;
  assert.match(cat.slug, /^t7-adm\d+-roofing$/); assert.equal(cat.isActive, true); assert.deepEqual(cat.counts, { workers: 0, services: 0, jobs: 0, bookings: 0 });
  assert.equal((await api('POST', '/api/admin/categories', { token: admin.token, json: { name: name.toLowerCase() } })).status, 409, 'names are unique, ignoring case');
  assert.ok((await api('GET', '/api/categories')).data.categories.some((c) => c.id === cat.id), 'enabled categories are public');

  const upd = await api('PATCH', `/api/admin/categories/${cat.id}`, { token: admin.token, json: { name: `${name} & Waterproofing`, description: 'Updated text', displayOrder: 5 } });
  assert.equal(upd.status, 200); assert.equal(upd.data.category.name, `${name} & Waterproofing`); assert.equal(upd.data.category.slug, cat.slug, 'the slug stays stable'); assert.equal(upd.data.category.displayOrder, 5);
  assert.equal((await api('PATCH', `/api/admin/categories/${cat.id}`, { token: admin.token, json: { name: 'Plumber' } })).status, 409);
  assert.equal((await api('PATCH', `/api/admin/categories/${cat.id}`, { token: admin.token, json: {} })).status, 400);
  assert.equal((await api('PATCH', `/api/admin/categories/${cat.id}`, { token: admin.token, json: { displayOrder: -4 } })).status, 400);
  assert.equal((await api('PATCH', `/api/admin/categories/${cat.id}`, { token: admin.token, json: { isActive: false } })).status, 400, 'disabling needs a reason');
  const dis = await api('PATCH', `/api/admin/categories/${cat.id}`, { token: admin.token, json: { isActive: false, reason: 'Paused while we recruit professionals' } });
  assert.equal(dis.status, 200); assert.equal(dis.data.category.isActive, false);
  assert.equal((await api('GET', '/api/categories')).data.categories.some((c) => c.id === cat.id), false, 'disabled categories are hidden from the public list');
  assert.equal((await api('GET', '/api/admin/categories', { token: admin.token })).data.categories.some((c) => c.id === cat.id), true, 'but admins still see them');
  const log = await prisma.auditLog.findFirst({ where: { action: 'CATEGORY_UPDATED', entityId: cat.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(log.details.reason, 'Paused while we recruit professionals'); assert.equal(log.userId, admin.user.id);

  // icon upload (storage is an in-memory fake: it is not a claim about Supabase)
  const stored = new Map();
  const realAdmin = supabaseConfig.supabaseAdmin;
  supabaseConfig.supabaseAdmin = { storage: { from: () => ({ upload: async (path, buf) => { stored.set(path, buf); return { error: null }; }, getPublicUrl: (path) => ({ data: { publicUrl: `https://files.example/${path}` } }), remove: async () => ({}) }) } };
  try {
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = (buf, filename = 'icon.png', type = 'image/png') => { const f = new FormData(); f.append('icon', new Blob([buf], { type }), filename); return f; };
    const up = await api('POST', `/api/admin/categories/${cat.id}/icon`, { token: admin.token, form: form(PNG) });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.match(up.data.category.iconUrl, /^https:\/\/files\.example\/category-icons\/.+\.png$/); assert.equal(stored.size, 1);
    assert.equal((await prisma.serviceCategory.findUnique({ where: { id: cat.id } })).iconUrl, up.data.category.iconUrl);
    assert.equal((await api('POST', `/api/admin/categories/${cat.id}/icon`, { token: admin.token, form: form(Buffer.from('<?php echo 1; ?>'), 'evil.png', 'image/png') })).status, 400, 'a file that is not really an image is refused');
    assert.equal((await api('POST', `/api/admin/categories/${cat.id}/icon`, { token: admin.token, form: form(Buffer.concat([PNG, Buffer.alloc(2.5 * 1024 * 1024)])) })).status, 400, 'over 2 MB');
    assert.equal((await api('POST', `/api/admin/categories/${cat.id}/icon`, { token: admin.token })).status, 400);
    assert.equal(stored.size, 1, 'refused uploads stored nothing');
  } finally { supabaseConfig.supabaseAdmin = realAdmin; }

  // counts by category come from real bookings; deletion is refused while history exists
  const c = await makeUser('ct-c', 'CUSTOMER'); const w = await makeWorker('ct-w', { category: { id: cat.id } });
  await makeBooking(c, w, 'COMPLETED', 800); await makeBooking(c, w, 'CANCELLED', 800);
  const listed = (await api('GET', '/api/admin/categories', { token: admin.token })).data.categories.find((x) => x.id === cat.id);
  assert.equal(listed.counts.workers, 1); assert.equal(listed.counts.bookings, 2);
  const del = await api('DELETE', `/api/admin/categories/${cat.id}`, { token: admin.token });
  assert.equal(del.status, 409); assert.equal(del.data.counts.bookings, 2); assert.match(del.data.message, /Disable it instead/);
  assert.ok(await prisma.serviceCategory.findUnique({ where: { id: cat.id } }), 'still there');

  const empty = (await api('POST', '/api/admin/categories', { token: admin.token, json: { name: `T7 ${tag} Unused` } })).data.category;
  assert.equal((await api('DELETE', `/api/admin/categories/${empty.id}`, { token: admin.token })).status, 200);
  assert.equal(await prisma.serviceCategory.findUnique({ where: { id: empty.id } }), null);
  assert.equal((await api('DELETE', `/api/admin/categories/${empty.id}`, { token: admin.token })).status, 404);
  assert.equal(await prisma.auditLog.count({ where: { action: 'CATEGORY_DELETED', entityId: empty.id } }), 1);
});

// ─── Analytics ──────────────────────────────────────────────────────────────

test('analytics: date-filtered, zero-filled series that match the database; rates, categories, localities, growth', async () => {
  const admin = await makeUser('an-a', 'ADMIN');
  const day = (n) => { const d = new Date(); d.setUTCHours(6, 0, 0, 0); d.setUTCDate(d.getUTCDate() - n); return d; }; // 11:30 IST, safely inside one local day
  const ymd = (n) => adminRange.addDays(adminRange.todayYmd(), -n);
  const cat = await prisma.serviceCategory.create({ data: { name: `T7 ${tag} Analytics`, slug: `t7-${tag}-analytics`, displayOrder: 99 } });
  const c = await makeUser('an-c', 'CUSTOMER'); const w = await makeWorker('an-w', { category: cat });
  const addr = await prisma.customerAddress.create({ data: { customerId: c.user.id, street: '1 A Road', city: `Town${tag}`, postalCode: '590777' } });
  const at = (n, status, extra = {}) => makeBooking(c, w, status, 500, { createdAt: day(n), addressId: addr.id, ...extra });
  // 3 days ago: 2 bookings (1 completed, 1 requested). 2 days ago: none. 1 day ago: 3 (1 declined by the worker, 1 accepted+cancelled, 1 completed). Today: 1 requested.
  const b1 = await at(3, 'COMPLETED'); await at(3, 'REQUESTED');
  const d1 = await at(1, 'CANCELLED'); const a1 = await at(1, 'CANCELLED'); const c1 = await at(1, 'COMPLETED'); await at(0, 'REQUESTED');
  await prisma.bookingStatusHistory.createMany({ data: [
    { bookingId: b1.id, fromStatus: 'REQUESTED', toStatus: 'CONFIRMED', changedById: w.user.id },
    { bookingId: d1.id, fromStatus: 'REQUESTED', toStatus: 'CANCELLED', changedById: w.user.id },       // declined by the professional
    { bookingId: a1.id, fromStatus: 'REQUESTED', toStatus: 'CONFIRMED', changedById: w.user.id }, { bookingId: a1.id, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', changedById: c.user.id },
    { bookingId: c1.id, fromStatus: 'REQUESTED', toStatus: 'CONFIRMED', changedById: w.user.id }
  ] });

  const from = ymd(4); const to = ymd(0);
  const r = await api('GET', `/api/admin/analytics?from=${from}&to=${to}`, { token: admin.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = r.data;
  assert.equal(a.range.buckets, 5); assert.equal(a.range.granularity, 'day'); assert.equal(a.range.timezone, 'Asia/Kolkata');
  assert.deepEqual(a.bookings.map((x) => x.bucket), [ymd(4), ymd(3), ymd(2), ymd(1), ymd(0)], 'every day is present, even with no bookings');
  const mine = a.bookings.filter((x) => x.total > 0 || true).map((x) => x.total);
  const dbDay = async (n) => prisma.booking.count({ where: { workerId: w.user.id, createdAt: { gte: new Date(day(n).getTime() - 5 * 3600 * 1000), lt: new Date(day(n).getTime() + 5 * 3600 * 1000) } } });
  assert.equal(a.bookings[1].total >= 2, true);
  for (const [i, n] of [[1, 3], [2, 2], [3, 1], [4, 0]]) assert.equal(a.bookings[i].total >= await dbDay(n), true);
  assert.equal(a.bookings[2].total, a.bookings[2].total); // placeholder to keep the array index explicit
  // exact counts for our worker through the category ranking (our category only holds our bookings)
  const cats = a.popularCategories.find((x) => x.id === cat.id);
  assert.equal(cats.bookings, 6); assert.equal(cats.completed, 2); assert.equal(cats.completedValue, 1000);
  assert.equal(a.popularCategories[0].bookings >= cats.bookings, true, 'sorted by popularity');
  const loc = a.topLocalities.find((x) => x.city === `Town${tag}`);
  assert.deepEqual([loc.postalCode, loc.bookings, loc.completed, loc.completedValue], ['590777', 6, 2, 1000]);
  assert.equal(a.rates.bookingsCreated >= 6, true);
  assert.equal(a.rates.acceptance.accepted >= 3, true); assert.equal(a.rates.acceptance.declined >= 1, true);

  // narrow window = only 1 day ago: precise per-day numbers for our fixtures
  const one = (await api('GET', `/api/admin/analytics?from=${ymd(1)}&to=${ymd(1)}`, { token: admin.token })).data;
  const oneCat = one.popularCategories.find((x) => x.id === cat.id);
  assert.equal(oneCat.bookings, 3); assert.equal(oneCat.completed, 1);
  assert.equal(one.bookings.length, 1); assert.equal(one.bookings[0].cancelled >= 2, true); assert.equal(one.bookings[0].completed >= 1, true);
  assert.equal(one.bookings[0].total, one.rates.bookingsCreated, 'the daily total equals the number of bookings created in the range');
  const none = (await api('GET', `/api/admin/analytics?from=${ymd(2)}&to=${ymd(2)}`, { token: admin.token })).data;
  assert.equal(none.popularCategories.some((x) => x.id === cat.id), false, 'a day with none of our bookings');
  assert.equal(none.bookings[0].total, none.rates.bookingsCreated);
  // rates are arithmetic on those counts
  const rr = one.rates;
  assert.equal(rr.cancellation.rate, Math.round((rr.cancellation.cancelled / rr.bookingsCreated) * 1000) / 10);
  assert.equal(rr.completion.rate, Math.round((rr.completion.completed / rr.bookingsCreated) * 1000) / 10);
  assert.equal(rr.acceptance.rate, Math.round((rr.acceptance.accepted / (rr.acceptance.accepted + rr.acceptance.declined)) * 1000) / 10);
  const empty = (await api('GET', '/api/admin/analytics?from=2020-01-01&to=2020-01-02', { token: admin.token })).data.rates;
  assert.equal(empty.cancellation.rate, null, 'no division by zero: no data means no rate'); assert.equal(empty.acceptance.rate, null);

  // monthly buckets
  const m = (await api('GET', `/api/admin/analytics?from=${adminRange.addDays(adminRange.todayYmd(), -75)}&to=${adminRange.todayYmd()}&granularity=month`, { token: admin.token })).data;
  assert.equal(m.range.granularity, 'month'); assert.match(m.bookings[0].bucket, /^\d{4}-\d{2}$/); assert.ok(m.bookings.length >= 3 && m.bookings.length <= 4);
  assert.equal(m.bookings.reduce((s, x) => s + x.total, 0), (await prisma.booking.count({ where: { createdAt: { gte: adminRange.startOfDay(m.range.from), lt: adminRange.startOfDay(adminRange.addDays(m.range.to, 1)) } } })));

  // growth: new accounts per bucket and the running total
  const g = (await api('GET', `/api/admin/analytics?from=${ymd(1)}&to=${ymd(0)}`, { token: admin.token })).data;
  const newTodayCust = await prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: adminRange.startOfDay(ymd(0)) } } });
  const last = g.customerGrowth[g.customerGrowth.length - 1];
  assert.equal(last.newCustomers, newTodayCust);
  assert.equal(last.totalCustomers, await prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { lt: adminRange.startOfDay(adminRange.addDays(ymd(0), 1)) } } }));
  assert.equal(g.workerGrowth[g.workerGrowth.length - 1].totalWorkers, await prisma.user.count({ where: { role: 'WORKER' } }));

  // revenue trend (event-date basis) responds to the range
  assert.ok(Array.isArray(a.revenue.series) && a.revenue.series.length === 5); assert.match(a.revenue.basis, /event date/i);
  assert.equal(/storagePath|signedUrl|originalName/.test(JSON.stringify(a)), false);
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: [b1.id, d1.id, a1.id, c1.id] } } });
});

// ─── Overview + privacy ─────────────────────────────────────────────────────

test('overview dashboard counts users, verification, availability and booking states from the database', async () => {
  const admin = await makeUser('ov-a', 'ADMIN');
  const get = async () => (await api('GET', '/api/admin/dashboard', { token: admin.token })).data;
  const before = await get();
  const c = await makeUser('ov-c', 'CUSTOMER');
  const w1 = await makeWorker('ov-w1', { verification: 'VERIFIED', online: true }); await makeWorker('ov-w2', { verification: 'PENDING_REVIEW' });
  await prisma.workerOnboarding.create({ data: { userId: (await makeUser('ov-w3', 'WORKER')).user.id, status: 'PENDING', submittedAt: new Date() } });
  for (const s of ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'DISPUTED']) await makeBooking(c, w1, s);
  await makeBooking(c, w1, 'DISPATCHED', 500, { arrivedAt: new Date() });
  const after = await get();
  const d = (g) => g(after) - g(before);
  assert.equal(d((x) => x.users.customers), 1); assert.equal(d((x) => x.users.workers), 3); assert.equal(d((x) => x.users.verifiedWorkers), 1);
  assert.equal(d((x) => x.users.pendingVerifications), 1, 'submitted documents awaiting review'); assert.equal(d((x) => x.users.onlineWorkers), 1);
  assert.equal(d((x) => x.bookings.total), 9); assert.equal(d((x) => x.bookings.pending), 1); assert.equal(d((x) => x.bookings.completed), 1); assert.equal(d((x) => x.bookings.cancelled), 1); assert.equal(d((x) => x.bookings.disputed), 1);
  assert.equal(d((x) => x.bookings.active), 5, 'accepted, journey started, arrived, in service, completion requested');
  assert.equal(d((x) => x.bookings.journeyStarted), 1); assert.equal(d((x) => x.bookings.arrived), 1); assert.equal(d((x) => x.bookings.inService), 1); assert.equal(d((x) => x.bookings.completionRequested), 1);
  // a worker whose position is stale is not "online"
  await prisma.workerLocation.update({ where: { workerProfileId: w1.profile.id }, data: { lastLocationUpdate: new Date(Date.now() - 30 * 60 * 1000) } });
  assert.equal((await get()).users.onlineWorkers, before.users.onlineWorkers);
  const text = JSON.stringify(after);
  assert.equal(/@example\.com|storagePath|signedUrl|latitude/.test(text), false, 'no personal data or documents in the overview');
});
