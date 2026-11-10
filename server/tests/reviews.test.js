// Phase 8: booking-verified reviews, ratings, reports and moderation. Real Express + real PostgreSQL (triggers and
// constraints included). The one completion in the end-to-end test goes through the real payment pipeline.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_reviews00001';
process.env.RAZORPAY_KEY_SECRET = 'reviews_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'reviews_webhook_secret';
process.env.PAYMENT_RATE_LIMIT_MAX = '100000';
process.env.REVIEW_RATE_LIMIT_MAX = '60';
delete process.env.PAYOUT_MODE;

const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const { signSessionToken } = require('../services/authTokens');
const { setRazorpayInstance } = require('../config/razorpay');
const reviewService = require('../services/reviewService');
const { server } = require('../server');
const { FakeRazorpay, checkoutSignature } = require('./helpers/fakeRazorpay');

const tag = `rv${Date.now()}`;
const created = [];
const gw = new FakeRazorpay();
let base; let plumber; let seq = 0;
const GOOD = 'Arrived on time and fixed the leak properly.';

async function api(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined && method !== 'GET') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + path, { method, headers, body });
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
  await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus: 'VERIFIED', hourlyRate: 300, bio: 'Pro', city: 'Belagavi', locality: 'Tilakwadi' } });
  return w;
}
const makeBooking = (c, w, status = 'COMPLETED', extra = {}) => prisma.booking.create({
  data: { bookingNumber: `BK-${tag}-${++seq}`, customerId: c.user.id, workerId: w.user.id, status, agreedPrice: 500, scheduledAt: new Date(Date.now() - 86400000), priceConfirmedAt: new Date(), problemDescription: 'Fix tap', ...extra }
});
const review = (c, b, body = {}) => api('POST', '/api/reviews', { token: c.token, json: { bookingId: b.id, rating: 5, comment: GOOD, ...body } });
const profile = (w) => prisma.workerProfile.findUnique({ where: { userId: w.user.id } });
const publicList = (w, q = '') => api('GET', `/api/reviews/worker/${w.user.id}${q}`);
const pgError = async (fn) => { try { await fn(); } catch (e) { return String(e.message); } return null; };

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
  const reviews = (await prisma.review.findMany({ where: { workerId: { in: created } }, select: { id: true } })).map((r) => r.id);
  const step = (p) => p.catch((e) => console.error('cleanup:', e.message));
  await step(prisma.reviewModerationEvent.deleteMany({ where: { reviewId: { in: reviews } } }));
  await step(prisma.reviewReport.deleteMany({ where: { reviewId: { in: reviews } } }));
  await step(prisma.review.deleteMany({ where: { id: { in: reviews } } }));
  await step(prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: pays } } }));
  await step(prisma.paymentRefund.deleteMany({ where: { paymentId: { in: pays } } }));
  await step(prisma.workerSettlement.deleteMany({ where: { paymentId: { in: pays } } }));
  await step(prisma.payment.deleteMany({ where: { id: { in: pays } } }));
  await step(prisma.supportTicket.deleteMany({ where: { OR: [{ bookingId: { in: bookings } }, { reporterId: { in: created } }] } }));
  await step(prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: created } }, { entityId: { in: [...reviews, ...created] } }] } }));
  await step(prisma.notification.deleteMany({ where: { userId: { in: created } } }));
  await step(prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookings } } }));
  await step(prisma.booking.deleteMany({ where: { id: { in: bookings } } }));
  await step(prisma.user.deleteMany({ where: { id: { in: created } } }));
  setRazorpayInstance(null);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ── Authorization ────────────────────────────────────────────────────────────
test('only the signed-in customer who owns the booking can review it', async () => {
  const c = await makeUser('au-c', 'CUSTOMER'); const other = await makeUser('au-o', 'CUSTOMER'); const w = await makeWorker('au-w'); const admin = await makeUser('au-a', 'ADMIN');
  const b = await makeBooking(c, w);
  assert.equal((await api('POST', '/api/reviews', { json: { bookingId: b.id, rating: 5, comment: GOOD } })).status, 401, 'no token');
  assert.equal((await review(w, b)).status, 403, 'the professional cannot review their own job');
  assert.equal((await review(admin, b)).status, 403, 'admins cannot write reviews');
  const stranger = await review(other, b);
  assert.equal(stranger.status, 404, 'another customer cannot tell the booking exists');
  assert.equal(await prisma.review.count({ where: { bookingId: b.id } }), 0);
  assert.equal((await api('POST', '/api/reviews', { token: c.token, json: { rating: 5, comment: GOOD } })).status, 400, 'a booking is required');
  assert.equal((await api('POST', '/api/reviews', { token: c.token, json: { bookingId: 'x'.repeat(200), rating: 5, comment: GOOD } })).status, 400);
  // the old job+worker lookup is gone: it could not tell two bookings of the same job apart
  assert.equal((await api('POST', '/api/reviews', { token: c.token, json: { jobId: 'any', workerId: w.user.id, rating: 5, comment: GOOD } })).status, 400);
  assert.equal((await review(c, b)).status, 201, 'the owner can');
});

// ── Eligibility ──────────────────────────────────────────────────────────────
test('only genuinely completed bookings can be reviewed: cancelled, disputed and unfinished ones cannot', async () => {
  const c = await makeUser('el-c', 'CUSTOMER'); const w = await makeWorker('el-w');
  for (const status of ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION']) {
    const b = await makeBooking(c, w, status);
    const r = await review(c, b);
    assert.equal(r.status, 422, status); assert.equal(r.data.code, 'NOT_COMPLETED', status);
  }
  const cancelled = await makeBooking(c, w, 'CANCELLED');
  assert.equal((await review(c, cancelled)).data.code, 'CANCELLED');
  const disputed = await makeBooking(c, w, 'DISPUTED');
  assert.equal((await review(c, disputed)).data.code, 'DISPUTED');
  const openDispute = await makeBooking(c, w, 'COMPLETED');
  await prisma.supportTicket.create({ data: { ticketNumber: `TCK-${tag}-1`, reporterId: c.user.id, bookingId: openDispute.id, subject: 'Problem', description: 'Work not done', status: 'OPEN' } });
  const blocked = await review(c, openDispute);
  assert.equal(blocked.status, 422); assert.equal(blocked.data.code, 'DISPUTED', 'an open dispute blocks the review');
  await prisma.supportTicket.updateMany({ where: { bookingId: openDispute.id }, data: { status: 'RESOLVED_PAYOUT' } });
  assert.equal((await review(c, openDispute)).status, 201, 'once the dispute is resolved the completed booking can be reviewed');
  assert.equal(await prisma.review.count({ where: { customerId: c.user.id } }), 1, 'nothing was stored for the refused attempts');

  // the booking payload tells the customer what is possible, and tells nobody else
  const list = (await api('GET', '/api/bookings/my', { token: c.token })).data.bookings;
  const by = (id) => list.find((x) => x.id === id);
  assert.equal(by(cancelled.id).reviewState.canReview, false); assert.match(by(cancelled.id).reviewState.reason, /cancelled/i);
  assert.equal(by(disputed.id).reviewState.canReview, false);
  assert.equal(by(openDispute.id).reviewState.canReview, false); assert.equal(by(openDispute.id).reviewState.code, 'ALREADY_REVIEWED');
  assert.equal(by(openDispute.id).reviewState.review.status, 'PUBLISHED');
  assert.ok(list.every((x) => !('disputes' in x) && !('review' in x)), 'raw relations are not leaked');
  const wl = (await api('GET', '/api/bookings/my', { token: w.token })).data.bookings;
  assert.ok(wl.every((x) => !('reviewState' in x) && !('review' in x)), 'professionals get no review fields in booking payloads');
  const one = (await api('GET', `/api/bookings/${openDispute.id}`, { token: c.token })).data.booking;
  assert.equal(one.reviewState.review.rating, 5);
});

test('end to end: confirming completion invites the customer to review, and the review notifies the professional', async () => {
  const c = await makeUser('e2e-c', 'CUSTOMER'); const w = await makeWorker('e2e-w');
  const b = await makeBooking(c, w, 'IN_PROGRESS', { agreedPrice: 800 });
  assert.equal((await review(c, b)).status, 422, 'not yet complete');
  const o = await api('POST', `/api/payments/booking/${b.id}/order`, { token: c.token });
  assert.ok([200, 201].includes(o.status), JSON.stringify(o.data));
  const ent = gw.pay(o.data.orderId);
  assert.equal((await api('POST', `/api/payments/booking/${b.id}/verify`, { token: c.token, json: { razorpay_order_id: o.data.orderId, razorpay_payment_id: ent.id, razorpay_signature: checkoutSignature(process.env.RAZORPAY_KEY_SECRET, o.data.orderId, ent.id) } })).status, 200);
  assert.equal((await api('PUT', `/api/bookings/${b.id}/status`, { token: w.token, json: { status: 'AWAITING_CUSTOMER_CONFIRMATION' } })).status, 200);
  assert.equal((await review(c, b)).data.code, 'NOT_COMPLETED', 'awaiting confirmation is not completion');
  assert.equal((await api('POST', `/api/payments/booking/${b.id}/confirm-completion`, { token: c.token })).status, 200);

  const prompt = await prisma.notification.findFirst({ where: { userId: c.user.id, bookingId: b.id, type: 'JOB_COMPLETED' } });
  assert.ok(prompt && /how did it go/i.test(prompt.title), 'the customer is prompted to review');
  const state = (await api('GET', '/api/bookings/my', { token: c.token })).data.bookings.find((x) => x.id === b.id).reviewState;
  assert.equal(state.canReview, true); assert.equal(state.review, null);

  const r = await review(c, b, { rating: 4, comment: 'Good work, a little late but tidy.' });
  assert.equal(r.status, 201); assert.equal(r.data.summary.count, 1); assert.equal(r.data.summary.average, 4);
  const note = await prisma.notification.findFirst({ where: { userId: w.user.id, type: 'REVIEW_SUBMITTED' } });
  assert.ok(note, 'the professional is notified'); assert.match(note.title, /4-star/); assert.equal(note.bookingId, b.id);
  assert.ok(!note.message.includes(c.user.email) && !note.message.includes('98765'), 'no private data in the notification');
  const after = (await api('GET', '/api/bookings/my', { token: c.token })).data.bookings.find((x) => x.id === b.id).reviewState;
  assert.equal(after.canReview, false); assert.equal(after.review.rating, 4);
  // payment and booking are exactly as they were
  assert.equal((await prisma.booking.findUnique({ where: { id: b.id } })).status, 'COMPLETED');
});

// ── Duplicates ───────────────────────────────────────────────────────────────
test('one review per booking: refused by the API, by concurrent submissions and by the database', async () => {
  const c = await makeUser('dup-c', 'CUSTOMER'); const w = await makeWorker('dup-w');
  const b = await makeBooking(c, w);
  assert.equal((await review(c, b)).status, 201);
  const again = await review(c, b, { rating: 1, comment: 'Changed my mind about this one.' });
  assert.equal(again.status, 409); assert.equal(again.data.code, 'ALREADY_REVIEWED');
  assert.equal((await prisma.review.findUnique({ where: { bookingId: b.id } })).rating, 5, 'the original is untouched');

  const b2 = await makeBooking(c, w);
  const results = await Promise.all(Array.from({ length: 5 }, () => review(c, b2, { rating: 3, comment: 'Racing submissions for one booking.' })));
  assert.equal(results.filter((r) => r.status === 201).length, 1, 'exactly one wins');
  assert.equal(results.filter((r) => r.status === 409).length, 4);
  assert.equal(await prisma.review.count({ where: { bookingId: b2.id } }), 1);
  assert.equal((await profile(w)).reviewsCount, 2, 'the counter counted each booking once');

  const err = await pgError(() => prisma.review.create({ data: { bookingId: b.id, customerId: c.user.id, workerId: w.user.id, rating: 2, comment: 'Direct duplicate insert' } }));
  assert.match(err, /Unique constraint/i, 'the unique index refuses it even without the API');
});

// ── Validation and sanitising ────────────────────────────────────────────────
test('server-side validation and sanitising', async () => {
  const c = await makeUser('val-c', 'CUSTOMER'); const w = await makeWorker('val-w');
  const b = await makeBooking(c, w);
  for (const rating of [0, 6, -1, 3.5, '4abc', 'five', null, undefined, '', [], {}, true]) {
    const r = await api('POST', '/api/reviews', { token: c.token, json: { bookingId: b.id, rating, comment: GOOD } });
    assert.equal(r.status, 400, `rating ${JSON.stringify(rating)}`); assert.equal(r.data.code, 'BAD_RATING');
  }
  for (const [comment, code] of [[undefined, 'COMMENT_TOO_SHORT'], ['', 'COMMENT_TOO_SHORT'], ['short', 'COMMENT_TOO_SHORT'], ['   ', 'COMMENT_TOO_SHORT'], ['<b></b><i>ok</i>', 'COMMENT_TOO_SHORT'], ['x'.repeat(1001), 'COMMENT_TOO_LONG'], ['!!!!!!!!!!!!!!', 'COMMENT_EMPTY'], [{ a: 1 }, 'COMMENT_TOO_SHORT'], [['a long enough array comment'], 'COMMENT_TOO_SHORT']]) {
    const r = await review(c, b, { comment });
    assert.equal(r.status, 400, JSON.stringify(comment)); assert.equal(r.data.code, code, JSON.stringify(comment));
  }
  assert.equal(await prisma.review.count({ where: { bookingId: b.id } }), 0, 'nothing stored for invalid input');

  // markup and control characters are stripped; whitespace is tidied; mass-assignment fields are ignored
  const r = await api('POST', '/api/reviews', { token: c.token, json: { bookingId: b.id, rating: '5', comment: '  <script>alert(1)</script>Great   work\u0000 and‮ punctual\n\n\n\nThanks <b>a lot</b>  ', status: 'HIDDEN', isVerified: false, customerId: 'x', workerId: 'y', hiddenReason: 'z' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = await prisma.review.findUnique({ where: { bookingId: b.id } });
  assert.equal(row.comment, 'alert(1) Great work and punctual\n\nThanks a lot');
  assert.ok(!/[<>\u0000‮]/.test(row.comment));
  assert.equal(row.status, 'PUBLISHED'); assert.equal(row.customerId, c.user.id); assert.equal(row.workerId, w.user.id); assert.equal(row.hiddenReason, null);
  const max = await makeBooking(c, w);
  assert.equal((await review(c, max, { comment: 'y'.repeat(1000) })).status, 201, '1000 characters is allowed');

  // database level: bounds, immutability, and booking integrity regardless of the API
  const ok = await makeBooking(c, w);
  assert.match(await pgError(() => prisma.review.create({ data: { bookingId: ok.id, customerId: c.user.id, workerId: w.user.id, rating: 9, comment: GOOD } })), /Review_rating_range_chk|check constraint/i);
  assert.match(await pgError(() => prisma.review.create({ data: { bookingId: ok.id, customerId: c.user.id, workerId: w.user.id, rating: 5, comment: 'z'.repeat(1001) } })), /Review_comment_length_chk|check constraint/i);
  const open = await makeBooking(c, w, 'IN_PROGRESS');
  assert.match(await pgError(() => prisma.review.create({ data: { bookingId: open.id, customerId: c.user.id, workerId: w.user.id, rating: 5, comment: GOOD } })), /review_booking_not_completed/);
  const w2 = await makeWorker('val-w2'); const c2 = await makeUser('val-c2', 'CUSTOMER');
  assert.match(await pgError(() => prisma.review.create({ data: { bookingId: ok.id, customerId: c2.user.id, workerId: w.user.id, rating: 5, comment: GOOD } })), /review_booking_mismatch/, 'wrong customer');
  assert.match(await pgError(() => prisma.review.create({ data: { bookingId: ok.id, customerId: c.user.id, workerId: w2.user.id, rating: 5, comment: GOOD } })), /review_booking_mismatch/, 'wrong professional');
  assert.match(await pgError(() => prisma.review.update({ where: { id: row.id }, data: { rating: 1 } })), /review_immutable/, 'a submitted review cannot be edited');
  assert.match(await pgError(() => prisma.review.update({ where: { id: row.id }, data: { comment: 'rewritten' } })), /review_immutable/);
  assert.match(await pgError(() => prisma.review.update({ where: { id: row.id }, data: { status: 'HIDDEN' } })), /Review_hidden_has_reason_chk|check constraint/i, 'hiding needs a recorded reason, even in SQL');
});

// ── Rating aggregation and public display ────────────────────────────────────
test('ratings are real averages of published reviews; no reviews means no rating; public payloads carry no private data', async () => {
  const w = await makeWorker('agg-w'); const c = await makeUser('agg-c', 'CUSTOMER');
  let pub = (await publicList(w)).data;
  assert.equal(pub.count, 0); assert.equal(pub.summary.average, null); assert.deepEqual(pub.reviews, []);
  let prof = (await api('GET', `/api/users/workers/${w.user.id}`)).data.worker;
  assert.equal(prof.rating, null); assert.equal(prof.reviewsCount, 0, 'no reviews: no rating, no count');

  for (const rating of [5, 4, 3, 5, 5]) await review(c, await makeBooking(c, w), { rating });
  pub = (await publicList(w)).data;
  assert.equal(pub.count, 5); assert.equal(pub.summary.count, 5); assert.equal(pub.summary.average, 4.4);
  assert.deepEqual(pub.summary.distribution, { 1: 0, 2: 0, 3: 1, 4: 1, 5: 3 });
  assert.equal(Number((await profile(w)).rating), 4.4); assert.equal((await profile(w)).reviewsCount, 5);
  prof = (await api('GET', `/api/users/workers/${w.user.id}`)).data.worker;
  assert.equal(prof.rating, 4.4); assert.equal(prof.reviewsCount, 5);
  const listed = (await api('GET', `/api/users/workers?q=${encodeURIComponent(w.user.name)}`)).data;
  const mine = (listed.workers || []).find((x) => x.id === w.user.id);
  if (mine) { assert.equal(mine.rating, 4.4); assert.equal(mine.reviewsCount, 5); }

  // pagination
  const p1 = (await publicList(w, '?limit=2&page=1')).data; const p3 = (await publicList(w, '?limit=2&page=3')).data;
  assert.equal(p1.reviews.length, 2); assert.equal(p1.pages, 3); assert.equal(p3.reviews.length, 1);
  assert.equal(new Set([...(await publicList(w, '?limit=2&page=1')).data.reviews, ...(await publicList(w, '?limit=2&page=2')).data.reviews, ...p3.reviews].map((x) => x.id)).size, 5, 'pages do not overlap');

  // privacy of what is public
  const body = JSON.stringify(pub);
  assert.ok(!body.includes(c.user.email) && !body.includes(c.user.id) && !body.includes('98765') && !/avatar/i.test(body), 'no customer id, e-mail, phone or photo');
  assert.deepEqual(Object.keys(pub.reviews[0]).sort(), ['comment', 'createdAt', 'id', 'rating', 'reviewerName', 'verifiedBooking']);
  assert.match(pub.reviews[0].reviewerName, /^\S+ [A-Z]\.$/);
  assert.equal((await api('GET', '/api/reviews/worker/not-a-real-id')).data.count, 0);
});

// ── The professional's side ──────────────────────────────────────────────────
test('professionals see their own reviews, cannot edit or delete them, and can report abusive ones', async () => {
  const c = await makeUser('wk-c', 'CUSTOMER'); const w = await makeWorker('wk-w'); const w2 = await makeWorker('wk-w2');
  const b1 = await makeBooking(c, w); const b2 = await makeBooking(c, w);
  const r1 = (await review(c, b1, { rating: 1, comment: 'You are all thieves and liars, terrible.' })).data.review;
  await review(c, b2, { rating: 5, comment: 'Lovely work and very polite.' });

  const mine = (await api('GET', '/api/reviews/received', { token: w.token })).data;
  assert.equal(mine.total, 2); assert.equal(mine.summary.average, 3);
  assert.ok(mine.reviews.every((x) => x.canReport === true && x.state === 'PUBLISHED'));
  assert.ok(!JSON.stringify(mine).includes(c.user.email) && !JSON.stringify(mine).includes(c.user.id));
  assert.equal((await api('GET', '/api/reviews/received', { token: w2.token })).data.total, 0, 'another professional sees none of them');
  assert.equal((await api('GET', '/api/reviews/received', { token: c.token })).status, 403);
  assert.equal((await api('GET', '/api/reviews/received')).status, 401);

  // no way to edit or delete through the API
  for (const m of ['PUT', 'PATCH', 'DELETE']) {
    for (const token of [w.token, c.token]) assert.ok([401, 403, 404].includes((await api(m, `/api/reviews/${r1.id}`, { token, json: { rating: 5, comment: 'edited by someone else' } })).status), `${m}`);
  }
  assert.equal((await prisma.review.findUnique({ where: { id: r1.id } })).rating, 1, 'unchanged');
  assert.match(await pgError(() => prisma.review.update({ where: { id: r1.id }, data: { rating: 5 } })), /review_immutable/);

  // reporting
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { token: c.token, json: { reason: 'ABUSIVE' } })).status, 403, 'customers cannot report');
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { json: { reason: 'ABUSIVE' } })).status, 401);
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { token: w2.token, json: { reason: 'ABUSIVE' } })).status, 404, 'only the reviewed professional can report');
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { token: w.token, json: { reason: 'NONSENSE' } })).data.code, 'BAD_REASON');
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { token: w.token, json: { reason: 'OTHER' } })).data.code, 'DETAILS_REQUIRED');
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { token: w.token, json: { reason: 'ABUSIVE', details: 'd'.repeat(1001) } })).data.code, 'DETAILS_TOO_LONG');
  const rep = await api('POST', `/api/reviews/${r1.id}/report`, { token: w.token, json: { reason: 'ABUSIVE', details: '<b>Insults</b> me personally' } });
  assert.equal(rep.status, 201, JSON.stringify(rep.data));
  assert.equal((await prisma.reviewReport.findFirst({ where: { reviewId: r1.id } })).details, 'Insults me personally');
  assert.equal((await api('POST', `/api/reviews/${r1.id}/report`, { token: w.token, json: { reason: 'FAKE_OR_FRAUDULENT' } })).status, 409, 'one report per professional per review');
  assert.equal(await prisma.reviewReport.count({ where: { reviewId: r1.id } }), 1);
  assert.equal((await api('POST', '/api/reviews/not-an-id/report', { token: w.token, json: { reason: 'ABUSIVE' } })).status, 404);

  // reporting alone changes nothing public
  assert.equal((await publicList(w)).data.count, 2); assert.equal(Number((await profile(w)).rating), 3);
  const after = (await api('GET', '/api/reviews/received', { token: w.token })).data;
  const state = after.reviews.find((x) => x.id === r1.id);
  assert.equal(state.state, 'REPORTED'); assert.equal(state.canReport, false); assert.equal(state.report.status, 'OPEN'); assert.equal(after.openReports, 1);
});

// ── Moderation ───────────────────────────────────────────────────────────────
test('admin moderation: access, mandatory reasons, hide/restore, history, audit log, and hidden reviews leave public ratings', async () => {
  const admin = await makeUser('mod-a', 'ADMIN'); const c = await makeUser('mod-c', 'CUSTOMER'); const w = await makeWorker('mod-w'); const w2 = await makeWorker('mod-w2');
  const mk = async (rating, comment) => (await review(c, await makeBooking(c, w), { rating, comment })).data.review;
  const good = await mk(5, 'Excellent, fixed everything quickly.'); const bad = await mk(1, 'Total scam, never hire this person!!');
  const fine = await mk(4, 'Good and tidy, fair price too.');
  assert.equal(Number((await profile(w)).rating), 3.33); assert.equal((await profile(w)).reviewsCount, 3);
  await api('POST', `/api/reviews/${bad.id}/report`, { token: w.token, json: { reason: 'FAKE_OR_FRAUDULENT', details: 'I never worked for this customer' } });

  // access
  for (const [method, path] of [['GET', '/api/admin/reviews'], ['GET', `/api/admin/reviews/${bad.id}`], ['POST', `/api/admin/reviews/${bad.id}/hide`], ['POST', `/api/admin/reviews/${bad.id}/restore`], ['POST', `/api/admin/reviews/${bad.id}/dismiss-reports`]]) {
    assert.equal((await api(method, path, { json: { reason: 'Because I said so' } })).status, 401, `${method} ${path} anonymous`);
    for (const who of [c, w]) assert.equal((await api(method, path, { token: who.token, json: { reason: 'Because I said so' } })).status, 403, `${method} ${path} non-admin`);
  }

  // list, filters, detail (no contact details anywhere)
  const A = (path, opts = {}) => api('GET', path, { token: admin.token, ...opts });
  const all = (await A(`/api/admin/reviews?q=${encodeURIComponent(w.user.name)}`)).data;
  assert.equal(all.total, 3); assert.ok(all.counts.reported >= 1);
  const reported = (await A(`/api/admin/reviews?state=REPORTED&q=${encodeURIComponent(w.user.name)}`)).data;
  assert.deepEqual(reported.reviews.map((r) => r.id), [bad.id]); assert.equal(reported.reviews[0].state, 'REPORTED'); assert.equal(reported.reviews[0].openReports, 1);
  assert.equal((await A(`/api/admin/reviews?state=PUBLISHED&q=${encodeURIComponent(w.user.name)}`)).data.total, 2);
  assert.equal((await A(`/api/admin/reviews?rating=5&q=${encodeURIComponent(w.user.name)}`)).data.total, 1);
  assert.equal((await A(`/api/admin/reviews?state=HIDDEN&q=${encodeURIComponent(w.user.name)}`)).data.total, 0);
  const detail = await A(`/api/admin/reviews/${bad.id}`);
  assert.equal(detail.data.review.reports.length, 1); assert.equal(detail.data.review.reports[0].reason, 'FAKE_OR_FRAUDULENT');
  assert.equal(detail.data.review.booking.status, 'COMPLETED');
  const raw = JSON.stringify(detail.data) + JSON.stringify(all);
  assert.ok(!raw.includes(c.user.email) && !raw.includes('98765') && !raw.includes(c.user.id), 'moderators see the customer name only');
  assert.equal((await A('/api/admin/reviews/does-not-exist')).status, 404);

  // reasons are mandatory
  const H = (id, reason, path = 'hide') => api('POST', `/api/admin/reviews/${id}/${path}`, { token: admin.token, json: reason === undefined ? {} : { reason } });
  for (const bad_ of [undefined, '', '   ', 'no', '<b></b>', 'r'.repeat(501)]) assert.equal((await H(bad.id, bad_)).status, 400, JSON.stringify(bad_));
  assert.equal((await prisma.review.findUnique({ where: { id: bad.id } })).status, 'PUBLISHED');
  assert.equal(await prisma.auditLog.count({ where: { entityId: bad.id, action: 'REVIEW_HIDDEN' } }), 0);

  // hide
  const hide = await H(bad.id, 'Fraudulent: the customer never booked this professional');
  assert.equal(hide.status, 200, JSON.stringify(hide.data)); assert.equal(hide.data.reportsResolved, 1);
  const hiddenRow = await prisma.review.findUnique({ where: { id: bad.id } });
  assert.equal(hiddenRow.status, 'HIDDEN'); assert.equal(hiddenRow.comment, 'Total scam, never hire this person!!', 'the evidence is preserved untouched');
  assert.equal(hiddenRow.hiddenById, admin.user.id); assert.ok(hiddenRow.hiddenAt);
  // hidden reviews no longer affect ANY public rating
  const pub = (await publicList(w)).data;
  assert.equal(pub.count, 2); assert.equal(pub.summary.count, 2); assert.equal(pub.summary.average, 4.5);
  assert.deepEqual(pub.summary.distribution, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 });
  assert.ok(!pub.reviews.some((r) => r.id === bad.id) && !JSON.stringify(pub).includes('scam'));
  assert.equal(Number((await profile(w)).rating), 4.5); assert.equal((await profile(w)).reviewsCount, 2);
  const prof = (await api('GET', `/api/users/workers/${w.user.id}`)).data.worker;
  assert.equal(prof.rating, 4.5); assert.equal(prof.reviewsCount, 2);
  const dash = (await api('GET', '/api/worker/dashboard', { token: w.token })).data;
  assert.ok(dash.reviews, 'dashboard has a reviews block'); assert.equal(dash.reviews.count, 2); assert.equal(dash.reviews.average, 4.5); assert.ok(!JSON.stringify(dash.reviews).includes('scam'));
  const received = (await api('GET', '/api/reviews/received', { token: w.token })).data;
  const placeholder = received.reviews.find((r) => r.id === bad.id);
  assert.equal(placeholder.state, 'HIDDEN'); assert.ok(!('comment' in placeholder) && !('rating' in placeholder), 'removed text is not shown to the professional');
  assert.equal(received.summary.count, 2);
  // report resolved, history and audit recorded
  assert.equal((await prisma.reviewReport.findFirst({ where: { reviewId: bad.id } })).status, 'UPHELD');
  assert.equal((await H(bad.id, 'Hiding it twice please')).status, 409);
  const ev = await prisma.reviewModerationEvent.findMany({ where: { reviewId: bad.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(ev.map((e) => e.action).sort(), ['HIDDEN', 'REPORT_UPHELD']); assert.ok(ev.every((e) => e.actorId === admin.user.id && e.reason.includes('Fraudulent')));
  const log = await prisma.auditLog.findFirst({ where: { entityId: bad.id, action: 'REVIEW_HIDDEN' } });
  assert.ok(log); assert.equal(log.userId, admin.user.id); assert.equal(log.entityType, 'REVIEW'); assert.match(log.details.reason, /never booked/); assert.ok(log.createdAt);
  const told = await prisma.notification.findFirst({ where: { userId: w.user.id, title: /removed after your report/i } });
  assert.ok(told, 'the reporting professional is told the outcome');
  const hiddenList = (await A(`/api/admin/reviews?state=HIDDEN&q=${encodeURIComponent(w.user.name)}`)).data;
  assert.deepEqual(hiddenList.reviews.map((r) => r.id), [bad.id], 'admins can still see hidden reviews');
  const adminDetail = (await A(`/api/admin/reviews/${bad.id}`)).data.review;
  assert.equal(adminDetail.state, 'HIDDEN'); assert.match(adminDetail.hiddenReason, /Fraudulent/); assert.equal(adminDetail.history.length, 2);

  // restore
  assert.equal((await H(good.id, 'Not hidden so cannot restore', 'restore')).status, 409);
  assert.equal((await H(bad.id, 'x', 'restore')).status, 400, 'restoring needs a reason too');
  const restore = await H(bad.id, 'Reviewed the booking record: the job genuinely happened', 'restore');
  assert.equal(restore.status, 200, JSON.stringify(restore.data));
  const back = (await publicList(w)).data;
  assert.equal(back.count, 3); assert.equal(back.summary.average, 3.3); assert.equal(Number((await profile(w)).rating), 3.33);
  assert.equal((await prisma.review.findUnique({ where: { id: bad.id } })).hiddenReason, null);
  assert.equal(await prisma.reviewModerationEvent.count({ where: { reviewId: bad.id } }), 3, 'history is append-only: hide, uphold, restore');
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: bad.id, action: 'REVIEW_RESTORED', userId: admin.user.id } }));

  // dismissing a report leaves the review published and rating unchanged
  assert.equal((await H(fine.id, 'No reports exist here', 'dismiss-reports')).status, 409);
  await api('POST', `/api/reviews/${fine.id}/report`, { token: w.token, json: { reason: 'OTHER', details: 'I simply disagree with this one' } });
  const dismiss = await H(fine.id, 'Honest review that merely disagrees; no policy breach', 'dismiss-reports');
  assert.equal(dismiss.status, 200, JSON.stringify(dismiss.data));
  assert.equal((await prisma.reviewReport.findFirst({ where: { reviewId: fine.id } })).status, 'DISMISSED');
  assert.equal((await prisma.review.findUnique({ where: { id: fine.id } })).status, 'PUBLISHED');
  assert.equal((await publicList(w)).data.count, 3);
  assert.ok(await prisma.auditLog.findFirst({ where: { entityId: fine.id, action: 'REVIEW_REPORTS_DISMISSED' } }));
  assert.ok(await prisma.notification.findFirst({ where: { userId: w.user.id, title: /report was reviewed/i } }));

  // the moderated professional's own admin profile shows review ids and states for follow-up
  const wd = (await A(`/api/admin/workers/${w.user.id}`)).data.worker || (await A(`/api/admin/workers/${w.user.id}`)).data;
  assert.ok(JSON.stringify(wd).includes(good.id), 'admin worker profile lists their reviews with ids');
  // a professional with no reviews is untouched by all of this
  assert.equal((await profile(w2)).reviewsCount, 0);

  // hiding the only review leaves an honest "no rating", not 0.0 stars
  const solo = await makeWorker('mod-solo'); const sc = await makeUser('mod-sc', 'CUSTOMER');
  const only = (await review(sc, await makeBooking(sc, solo), { rating: 2, comment: 'Not great, but the only one.' })).data.review;
  await H(only.id, 'Duplicate account abuse confirmed');
  const noRating = (await api('GET', `/api/users/workers/${solo.user.id}`)).data.worker;
  assert.equal(noRating.rating, null); assert.equal(noRating.reviewsCount, 0);
  assert.equal((await publicList(solo)).data.summary.average, null);
});

// ── Rate limiting ────────────────────────────────────────────────────────────
test('review writes are rate limited per account', async () => {
  const c = await makeUser('rl-c', 'CUSTOMER'); const other = await makeUser('rl-o', 'CUSTOMER'); const w = await makeWorker('rl-w');
  const b = await makeBooking(c, w);
  const statuses = [];
  for (let i = 0; i < 62; i += 1) statuses.push((await api('POST', '/api/reviews', { token: c.token, json: { bookingId: b.id, rating: 0, comment: GOOD } })).status);
  assert.deepEqual(statuses.slice(0, 60).filter((s) => s !== 400), [], 'within the limit these are plain validation errors');
  assert.equal(statuses[61], 429, 'beyond it the account is throttled');
  const ob = await makeBooking(other, w);
  assert.equal((await review(other, ob)).status, 201, 'one account\'s throttling does not affect another account');
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
test('reviewer labels and state derivation', () => {
  assert.equal(reviewService.reviewerLabel('Priya Sharma'), 'Priya S.');
  assert.equal(reviewService.reviewerLabel('priya'), 'priya');
  assert.equal(reviewService.reviewerLabel(''), 'Customer');
  assert.equal(reviewService.reviewerLabel(null), 'Customer');
  assert.equal(reviewService.reviewerLabel('Ravi Kumar Singh'), 'Ravi S.');
  assert.equal(reviewService.stateOf({ status: 'PUBLISHED' }, 0), 'PUBLISHED');
  assert.equal(reviewService.stateOf({ status: 'PUBLISHED' }, 2), 'REPORTED');
  assert.equal(reviewService.stateOf({ status: 'HIDDEN' }, 2), 'HIDDEN');
});
