// Verification gating + genuine reviews. Real Express routes and real PostgreSQL (DATABASE_URL);
// no mocks of the code under test. Requires a database with all migrations applied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');

const tag = `gate${Date.now()}`;
const created = [];
let base;
let plumber;

async function api(method, route, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + route, { method, headers, body: json ? JSON.stringify(json) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}

async function makeUser(label, role, extra = {}) {
  const user = await prisma.user.create({
    data: { email: `${tag}.${label}@example.com`, name: `${tag} ${label}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210', ...extra }
  });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}

// A discoverable worker (fresh, shared, available location) with the given verification status
async function makeWorker(label, verificationStatus, { isActive = true, reviewsCount = 0, rating = 0 } = {}) {
  const w = await makeUser(label, 'WORKER', { isActive });
  const profile = await prisma.workerProfile.create({
    data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus, hourlyRate: 300, bio: 'Plumber for homes.', reviewsCount, rating }
  });
  await prisma.workerLocation.create({
    data: { workerProfileId: profile.id, latitude: 15.85, longitude: 74.51, lastLocationUpdate: new Date(), isAvailable: true, sharingEnabled: true }
  });
  return { ...w, profile };
}

const future = () => new Date(Date.now() + 2 * 86400000).toISOString();

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  assert.ok(plumber, 'migrations must have been applied (Plumber category missing)');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await prisma.review.deleteMany({ where: { workerId: { in: created } } }).catch(() => {});
  await prisma.workerSettlement.deleteMany({ where: { workerId: { in: created } } }).catch(() => {});
  await prisma.payment.deleteMany({ where: { workerId: { in: created } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { OR: [{ workerId: { in: created } }, { customerId: { in: created } }] } }).catch(() => {});
  await prisma.jobApplication.deleteMany({ where: { workerId: { in: created } } }).catch(() => {});
  await prisma.jobPost.deleteMany({ where: { customerId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('discovery lists ONLY approved workers (plain and geospatial queries)', async () => {
  const verified = await makeWorker('d-verified', 'VERIFIED');
  const unverified = await makeWorker('d-unverified', 'UNVERIFIED');
  const pending = await makeWorker('d-pending', 'PENDING_REVIEW');
  const rejected = await makeWorker('d-rejected', 'REJECTED');
  const inactive = await makeWorker('d-inactive', 'VERIFIED', { isActive: false });
  const { token: customer } = await makeUser('d-customer', 'CUSTOMER');

  for (const query of [`?q=${tag}&category=Plumber`, `?q=${tag}&category=Plumber&lat=15.85&lng=74.51&radiusKm=50`]) {
    const r = await api('GET', `/api/users/workers${query}`, { token: customer });
    assert.equal(r.status, 200);
    const ids = r.data.workers.map((w) => w.id);
    assert.deepEqual(ids, [verified.user.id], `only the verified worker is listed for ${query}`);
    assert.equal(r.data.workers[0].isVerified, true);
  }
  // anonymous visitors get the same list
  const anon = await api('GET', `/api/users/workers?q=${tag}`);
  assert.deepEqual(anon.data.workers.map((w) => w.id), [verified.user.id]);
  void unverified; void pending; void rejected; void inactive;
});

test('public profile exists only for approved workers (owner, admin and customers with history excepted)', async () => {
  const verified = await makeWorker('p-verified', 'VERIFIED');
  const pending = await makeWorker('p-pending', 'PENDING_REVIEW');
  const { token: admin } = await makeUser('p-admin', 'ADMIN');
  const withHistory = await makeUser('p-hist', 'CUSTOMER');
  const stranger = await makeUser('p-stranger', 'CUSTOMER');
  await prisma.booking.create({ data: { bookingNumber: `BK-${tag}-p`, customerId: withHistory.user.id, workerId: pending.user.id, status: 'COMPLETED', scheduledAt: new Date(Date.now() - 86400000), agreedPrice: 300 } });

  assert.equal((await api('GET', `/api/users/workers/${verified.user.id}`)).status, 200);
  assert.equal((await api('GET', `/api/users/workers/${pending.user.id}`)).status, 404, 'anonymous');
  assert.equal((await api('GET', `/api/users/workers/${pending.user.id}`, { token: stranger.token })).status, 404, 'unrelated customer');
  assert.equal((await api('GET', `/api/users/workers/${pending.user.id}`, { token: pending.token })).status, 200, 'the worker themself');
  assert.equal((await api('GET', `/api/users/workers/${pending.user.id}`, { token: admin })).status, 200, 'admin');
  const hist = await api('GET', `/api/users/workers/${pending.user.id}`, { token: withHistory.token });
  assert.equal(hist.status, 200, 'customer with an existing booking');
  assert.equal(hist.data.worker.isVerified, false);
});

test('new bookings are refused for every non-approved state, allowed for approved workers', async () => {
  const { user: customer, token } = await makeUser('b-customer', 'CUSTOMER');
  const body = (workerId) => ({ workerId, scheduledAt: future(), agreedPrice: 500 });

  for (const status of ['UNVERIFIED', 'PENDING_REVIEW', 'REJECTED']) {
    const w = await makeWorker(`b-${status}`, status);
    const r = await api('POST', '/api/bookings', { token, json: body(w.user.id) });
    assert.equal(r.status, 403, status);
    assert.equal(r.data.code, 'WORKER_NOT_VERIFIED');
  }
  const inactive = await makeWorker('b-inactive', 'VERIFIED', { isActive: false });
  assert.equal((await api('POST', '/api/bookings', { token, json: body(inactive.user.id) })).status, 403);
  assert.equal(await prisma.booking.count({ where: { customerId: customer.id } }), 0, 'no booking row was created');

  const verified = await makeWorker('b-verified', 'VERIFIED');
  const ok = await api('POST', '/api/bookings', { token, json: body(verified.user.id) });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));

  // withdrawing approval closes the door again immediately
  await prisma.workerProfile.update({ where: { userId: verified.user.id }, data: { verificationStatus: 'REJECTED' } });
  const later = await api('POST', '/api/bookings', { token, json: { ...body(verified.user.id), scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString() } });
  assert.equal(later.status, 403);
  // ...while the booking made earlier stays visible and intact
  const existing = await api('GET', `/api/bookings/${ok.data.booking.id}`, { token });
  assert.equal(existing.status, 200);
});

test('job quotes also require approval', async () => {
  const { user: customer, token: customerToken } = await makeUser('e-customer', 'CUSTOMER');
  const job = await prisma.jobPost.create({ data: { customerId: customer.id, categoryId: plumber.id, title: `${tag} leak`, description: 'Fix a leaking pipe in the kitchen.' } });
  const bad = await makeWorker('e-pending', 'PENDING_REVIEW');
  const good = await makeWorker('e-verified', 'VERIFIED');

  // the old escrow funding endpoint is gone; payments only start from a confirmed booking
  let r = await api('POST', '/api/escrow/fund', { token: customerToken, json: { jobId: job.id, workerId: bad.user.id, amount: 500 } });
  assert.equal(r.status, 404);
  assert.equal(await prisma.booking.count({ where: { jobPostId: job.id } }), 0);

  // quotes
  r = await api('POST', '/api/applications', { token: bad.token, json: { jobId: job.id, quote: 400, message: 'I can do it' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'WORKER_NOT_VERIFIED');
  assert.equal(await prisma.jobApplication.count({ where: { jobId: job.id } }), 0);
  r = await api('POST', '/api/applications', { token: good.token, json: { jobId: job.id, quote: 400, message: 'I can do it' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));

  // a quote cannot be accepted once the worker's approval is gone
  const applicationId = r.data.application.id || r.data.application._id;
  await prisma.workerProfile.update({ where: { userId: good.user.id }, data: { verificationStatus: 'UNVERIFIED' } });
  r = await api('PUT', `/api/applications/${applicationId}/accept`, { token: customerToken });
  assert.equal(r.status, 409);
  assert.equal((await prisma.jobPost.findUnique({ where: { id: job.id } })).status, 'OPEN', 'job was not moved to IN_PROGRESS');
});

test('onboarding and verification stay fully accessible to non-approved workers', async () => {
  const w = await makeWorker('o-unverified', 'UNVERIFIED');
  for (const route of ['/api/worker/status', '/api/worker/onboarding', '/api/worker/dashboard']) {
    assert.equal((await api('GET', route, { token: w.token })).status, 200, route);
  }
  const save = await api('PUT', '/api/worker/onboarding/step/2', { token: w.token, json: { data: { skills: ['Pipe fitting'] }, complete: false } });
  assert.equal(save.status, 200);
  const dash = await api('GET', '/api/worker/dashboard', { token: w.token });
  assert.equal(dash.data.verification.isVerified, false);
});

test('existing workers: no automatic approval, no deletion; approval only via document review, then they are bookable', async () => {
  const legacy = await makeWorker('x-legacy', 'UNVERIFIED');
  const before = await prisma.workerProfile.findUnique({ where: { userId: legacy.user.id } });
  assert.equal(before.verificationStatus, 'UNVERIFIED');
  const { token: admin } = await makeUser('x-admin', 'ADMIN');
  const { token: customer } = await makeUser('x-customer', 'CUSTOMER');

  // The old shortcut is closed...
  let r = await api('PATCH', `/api/admin/users/${legacy.user.id}/verify`, { token: admin, json: { status: 'VERIFIED', notes: 'trust me' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'WORKER_VERIFICATION_REQUIRES_REVIEW');
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: legacy.user.id } })).verificationStatus, 'UNVERIFIED');
  assert.equal(await prisma.auditLog.count({ where: { action: 'WORKER_DIRECT_VERIFICATION_BLOCKED', entityId: legacy.user.id } }), 1, 'attempt is audit-logged');
  assert.equal((await api('POST', '/api/bookings', { token: customer, json: { workerId: legacy.user.id, scheduledAt: future(), agreedPrice: 400 } })).status, 403);

  // ...the document-review workflow is the only way in.
  const onboarding = await prisma.workerOnboarding.create({ data: { userId: legacy.user.id, status: 'UNDER_REVIEW', submittedAt: new Date(), attemptCount: 1 } });
  await prisma.workerDocument.create({
    data: { userId: legacy.user.id, onboardingId: onboarding.id, type: 'GOVT_ID_PAN', originalName: 'pan.png', mimeType: 'image/png', sizeBytes: 100, storageBucket: 'worker-documents', storagePath: `${legacy.user.id}/${tag}.png`, status: 'VERIFIED' }
  });
  r = await api('POST', `/api/admin/worker-verifications/${legacy.user.id}/approve`, { token: admin, json: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await prisma.auditLog.count({ where: { action: 'WORKER_VERIFIED', entityId: onboarding.id } })), 1);

  const found = await api('GET', `/api/users/workers?q=${encodeURIComponent(tag + ' x-legacy')}`, { token: customer });
  assert.deepEqual(found.data.workers.map((x) => x.id), [legacy.user.id], 'approved worker now appears in discovery');
  const booking = await api('POST', '/api/bookings', { token: customer, json: { workerId: legacy.user.id, scheduledAt: future(), agreedPrice: 400 } });
  assert.equal(booking.status, 201);
  assert.ok(await prisma.workerProfile.findUnique({ where: { userId: legacy.user.id } }), 'profile retained');
});

test('withdrawal through the legacy endpoint is still possible, keeps the review record in sync and is audited', async () => {
  const w = await makeWorker('w-verified', 'VERIFIED');
  const { token: admin, user: adminUser } = await makeUser('w-admin', 'ADMIN');
  const onboarding = await prisma.workerOnboarding.create({ data: { userId: w.user.id, status: 'VERIFIED', submittedAt: new Date(), attemptCount: 1 } });
  const r = await api('PATCH', `/api/admin/users/${w.user.id}/verify`, { token: admin, json: { status: 'REJECTED', notes: 'Documents found to be invalid' } });
  assert.equal(r.status, 200);
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: w.user.id } })).verificationStatus, 'REJECTED');
  const rec = await prisma.workerOnboarding.findUnique({ where: { id: onboarding.id } });
  assert.equal(rec.status, 'REJECTED');
  assert.match(rec.decisionReason, /invalid/);
  assert.ok(await prisma.workerVerificationEvent.findFirst({ where: { onboardingId: onboarding.id, action: 'VERIFICATION_WITHDRAWN' } }));
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'USER_VERIFICATION_UPDATED', entityId: w.user.id, userId: adminUser.id } }));
});

// ── Genuine reviews ──────────────────────────────────────────────────────────

test('a worker with no reviews has no rating and no count; real reviews drive the numbers', async () => {
  const none = await makeWorker('r-none', 'VERIFIED', { reviewsCount: 0, rating: 5 }); // even a stale stored 5.00 is not shown
  let r = await api('GET', `/api/users/workers/${none.user.id}`);
  assert.equal(r.data.worker.rating, null);
  assert.equal(r.data.worker.reviewsCount, 0);
  r = await api('GET', `/api/reviews/worker/${none.user.id}`);
  assert.equal(r.data.count, 0);
  assert.deepEqual(r.data.reviews, []);

  const rated = await makeWorker('r-some', 'VERIFIED');
  const { user: customer } = await makeUser('r-customer', 'CUSTOMER');
  const booking = await prisma.booking.create({ data: { bookingNumber: `BK-${tag}-r`, customerId: customer.id, workerId: rated.user.id, status: 'COMPLETED', scheduledAt: new Date(Date.now() - 86400000), agreedPrice: 300 } });
  await prisma.review.create({ data: { bookingId: booking.id, customerId: customer.id, workerId: rated.user.id, rating: 4, comment: 'Solid work' } });
  await prisma.workerProfile.update({ where: { userId: rated.user.id }, data: { rating: 4, reviewsCount: 1 } });
  r = await api('GET', `/api/users/workers/${rated.user.id}`);
  assert.equal(r.data.worker.rating, 4);
  assert.equal(r.data.worker.reviewsCount, 1);
  r = await api('GET', `/api/reviews/worker/${rated.user.id}`);
  assert.equal(r.data.count, 1);
  assert.equal(r.data.reviews[0].comment, 'Solid work');

  // new profiles no longer start at a 5.0 rating
  const fresh = await prisma.workerProfile.create({ data: { userId: (await makeUser('r-fresh', 'WORKER')).user.id, primaryCategoryId: plumber.id } });
  assert.equal(Number(fresh.rating), 0);
});

test('the frontend contains no hard-coded reviews, placeholder ratings or mock workers', () => {
  const pub = path.join(__dirname, '..', '..', 'public');
  const read = (rel) => fs.readFileSync(path.join(pub, rel), 'utf8');
  const profile = read('pages/profile.html');
  for (const phrase of ['Mock Reviews', 'Excellent service!', 'Very solid work', 'incredibly professional', 'Great communication throughout']) {
    assert.ok(!profile.includes(phrase), `profile.html still contains "${phrase}"`);
  }
  assert.ok(profile.includes('No reviews yet'), 'profile.html has a proper empty state');
  assert.ok(profile.includes('LH.data.reviews'), 'profile.html loads real reviews from the API');
  const mk = fs.readFileSync(path.join(pub, 'js/marketplace.js'), 'utf8');
  assert.ok(mk.includes("'/reviews/worker/'"), 'the reviews API is the only review source');
  assert.ok(!/https?:\/\/api\.dicebear/i.test(mk + profile),'customer pages never build a generated cartoon avatar URL (they only filter old ones out)');
  for (const file of ['pages/profile.html', 'js/app.js', 'pages/search.html', 'index.html', 'pages/edit-profile.html']) {
    const src = read(file);
    assert.ok(!/rating\s*\|\|\s*5(\.0)?\b/.test(src), `${file} defaults a missing rating to 5.0`);
    assert.ok(!/reviewsCount\s*\|\|\s*[1-9]/.test(src), `${file} fabricates a review count`);
  }
  const data = read('js/data.js');
  assert.ok(!data.includes('mockWorkers'), 'data.js still defines mock workers');
  assert.ok(!/reviewsCount:\s*\d{2,}/.test(data), 'data.js still contains fabricated review counts');
  const api = read('js/api.js');
  assert.ok(!api.includes("adding review locally") && !api.includes('localHire_reviews'), 'api.js still fabricates reviews offline');
  assert.ok(!api.includes('window.localHireApp.getWorkers()'), 'api.js still falls back to local workers');
});
