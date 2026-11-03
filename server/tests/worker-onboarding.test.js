// Worker onboarding & verification: real Express routes + real PostgreSQL (DATABASE_URL), with Supabase
// Storage replaced by an in-memory fake (private-bucket behaviour is asserted against the fake, NOT the
// live Supabase Storage service). Requires a database with all migrations applied.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const storage = require('../services/documentStorage');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');
const ob = require('../services/workerOnboarding');

// ── In-memory Supabase Storage ───────────────────────────────────────────────
const bucketState = { created: [], public: false };
const objects = new Map();
const fakeStorage = {
  getBucket: async (id) => (bucketState.created.includes(id) ? { data: { id, public: bucketState.public }, error: null } : { data: null, error: { message: 'not found' } }),
  createBucket: async (id, opts) => { bucketState.created.push(id); bucketState.public = Boolean(opts && opts.public); return { data: {}, error: null }; },
  from: (bucket) => ({
    upload: async (path, buffer) => { objects.set(`${bucket}/${path}`, buffer); return { data: { path }, error: null }; },
    createSignedUrl: async (path, seconds) => ({ data: { signedUrl: `https://storage.test/sign/${bucket}/${path}?token=t&exp=${seconds}` }, error: null }),
    remove: async (paths) => { paths.forEach((p) => objects.delete(`${bucket}/${p}`)); return { data: {}, error: null }; }
  })
};
const originalAdmin = supabaseConfig.supabaseAdmin;

const tag = `wo${Date.now()}`;
const created = { userIds: [] };
let base;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 2)]);

async function api(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(base + path, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  return { status: res.status, data };
}
const upload = (token, type, buffer, { name = 'id.png', mime = 'image/png' } = {}) => {
  const form = new FormData();
  form.append('type', type);
  form.append('file', new Blob([buffer], { type: mime }), name);
  return api('POST', '/api/worker/onboarding/documents', { token, form });
};

async function makeUser(label, role, extra = {}) {
  const user = await prisma.user.create({
    data: { email: `${tag}.${label}@example.com`, name: `Test ${label}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210', ...extra }
  });
  created.userIds.push(user.id);
  return { user, token: signSessionToken(user) };
}

const validSteps = (categoryId, extraCategoryId) => ({
  1: { fullName: 'Ravi Kumar', phone: '+91 98765 11111', city: 'Belagavi', locality: 'Tilakwadi', address: '14th Cross, Tilakwadi, Belagavi 590006' },
  2: { categoryId, experienceYears: 6, skills: ['Wiring', 'Inverter setup'], description: 'Licensed electrician handling residential repairs, rewiring and fittings.', previousExperience: 'Five years at a local contractor.', languages: ['English', 'Kannada'] },
  3: { idPolicyAcknowledged: true },
  4: { additionalCategoryIds: extraCategoryId ? [extraCategoryId] : [], hourlyRate: 450, startingCharge: 150, serviceRadiusKm: 15, workingHours: [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startTime: '09:00', endTime: '18:00', isActive: true })) }
});

async function completeAllSteps(token, steps) {
  for (const step of [1, 2, 3, 4]) {
    const r = await api('PUT', `/api/worker/onboarding/step/${step}`, { token, json: { data: steps[step], complete: true } });
    assert.equal(r.status, 200, `step ${step}: ${JSON.stringify(r.data)}`);
  }
}

test.before(async () => {
  supabaseConfig.supabaseAdmin = { storage: fakeStorage };
  storage._resetForTests();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  supabaseConfig.supabaseAdmin = originalAdmin;
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ── Pure rules ───────────────────────────────────────────────────────────────

test('validators, file sniffing and approval rules (no database needed)', () => {
  assert.ok(Object.keys(ob.validateStep(1, {}).errors).length >= 4);
  assert.equal(ob.validateStep(1, validSteps('c')[1]).errors.fullName, undefined);
  assert.ok(ob.validateStep(4, { hourlyRate: 0, startingCharge: 0, serviceRadiusKm: 10, workingHours: [{ dayOfWeek: 1 }] }).errors.pricing);
  assert.ok(ob.validateStep(4, { hourlyRate: 100, serviceRadiusKm: 500, workingHours: [] }).errors.serviceRadiusKm);
  assert.ok(ob.validateStep(4, { hourlyRate: 100, serviceRadiusKm: 5, workingHours: [{ dayOfWeek: 1, startTime: '18:00', endTime: '09:00' }] }).errors.workingHours);
  assert.equal(storage.sniffMime(PNG), 'image/png');
  assert.equal(storage.sniffMime(PDF), 'application/pdf');
  assert.equal(storage.sniffMime(Buffer.from('<script>alert(1)</script>-----')), null);
  assert.equal(ob.canApprove('PENDING', []).ok, false);
  const idDoc = { isCurrent: true, type: 'GOVT_ID_PAN', status: 'VERIFIED' };
  assert.equal(ob.canApprove('UNDER_REVIEW', [idDoc]).ok, true);
  assert.equal(ob.canApprove('UNDER_REVIEW', [idDoc, { isCurrent: true, type: 'PROFESSIONAL_CERTIFICATE', status: 'PENDING' }]).ok, false);
  assert.equal(ob.canApprove('VERIFIED', [idDoc]).ok, false);
  assert.equal(ob.toLegacyStatus('RESUBMISSION_REQUIRED'), 'UNVERIFIED');
});

// ── Categories ───────────────────────────────────────────────────────────────

test('categories are served from the database and include the requested taxonomy', async () => {
  const r = await api('GET', '/api/categories');
  assert.equal(r.status, 200);
  const names = r.data.categories.map((c) => c.name);
  for (const expected of ['Painter', 'Carpenter', 'Plumber', 'Electrician', 'Tutor', 'Cleaner', 'AC Repair', 'Appliance Repair', 'Mechanic', 'Pest Control', 'Gardener', 'Mason', 'Tailor', 'Movers and Packers', 'Beauty Services']) {
    assert.ok(names.includes(expected), `missing category ${expected}`);
  }
});

// ── New worker: incomplete → save/resume → upload → submit ───────────────────

test('new worker: incomplete onboarding, save and resume, document upload, submit', async () => {
  const cats = (await api('GET', '/api/categories')).data.categories;
  const electrician = cats.find((c) => c.name === 'Electrician').id;
  const plumber = cats.find((c) => c.name === 'Plumber').id;
  const { user, token } = await makeUser('newworker', 'WORKER', { phone: null });
  const steps = validSteps(electrician, plumber);

  let r = await api('GET', '/api/worker/status', { token });
  assert.equal(r.data.state, 'NOT_STARTED');

  // Strict completion of an empty step is refused, nothing is invented
  r = await api('PUT', '/api/worker/onboarding/step/1', { token, json: { data: {}, complete: true } });
  assert.equal(r.status, 400);
  assert.ok(r.data.errors.fullName && r.data.errors.phone && r.data.errors.photo);

  // Partial save is allowed and resumable
  r = await api('PUT', '/api/worker/onboarding/step/2', { token, json: { data: { categoryId: electrician, skills: ['Wiring'] }, complete: false } });
  assert.equal(r.status, 200);
  r = await api('GET', '/api/worker/status', { token });
  assert.equal(r.data.state, 'DRAFT');
  r = await api('GET', '/api/worker/onboarding', { token });
  assert.equal(r.data.onboarding.draft.professional.categoryId, electrician);
  assert.deepEqual(r.data.onboarding.draft.professional.skills, ['Wiring']);
  assert.equal(r.data.onboarding.account.email, user.email);
  assert.equal(r.data.onboarding.status, null);

  // Submitting an incomplete application lists exactly what is missing
  r = await api('POST', '/api/worker/onboarding/submit', { token, json: { declaration: true } });
  assert.equal(r.status, 400);
  const fields = r.data.problems.map((p) => p.field);
  assert.ok(fields.includes('city') && fields.includes('identity') && fields.includes('photo') && fields.includes('description'));
  assert.equal(await prisma.workerProfile.count({ where: { userId: user.id } }), 0, 'no profile created by a failed submit');

  // Unsafe uploads are rejected
  r = await upload(token, 'GOVT_ID_PAN', Buffer.from('this is not an image, it is text pretending to be one'), { name: 'x.png', mime: 'image/png' });
  assert.equal(r.status, 400, 'content sniffing rejects a fake PNG');
  r = await upload(token, 'GOVT_ID_PAN', PNG, { name: 'x.exe', mime: 'application/x-msdownload' });
  assert.equal(r.status, 400, 'declared type rejected');
  r = await upload(token, 'NOT_A_TYPE', PNG);
  assert.equal(r.status, 400);
  r = await upload(token, 'GOVT_ID_PAN', Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]));
  assert.equal(r.status, 400, 'over the size limit');
  assert.match(r.data.message, /too large/i);

  // Valid upload (a PDF and a PNG)
  r = await upload(token, 'GOVT_ID_PAN', PNG, { name: 'my pan (front).png' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.document.status, 'PENDING', 'uploads are never auto-verified');
  assert.equal(r.data.document.storagePath, undefined, 'storage path is not exposed');
  const doc = r.data.document;
  const stored = await prisma.workerDocument.findUnique({ where: { id: doc.id } });
  assert.equal(stored.storageBucket, 'worker-documents');
  assert.match(stored.storagePath, new RegExp(`^${user.id}/[0-9a-f-]{36}\\.png$`), 'server-generated key, filename not used');
  assert.ok(objects.has(`worker-documents/${stored.storagePath}`));
  assert.equal(bucketState.public, false, 'bucket created private');
  r = await upload(token, 'PROFESSIONAL_CERTIFICATE', PDF, { name: 'licence.pdf', mime: 'application/pdf' });
  assert.equal(r.status, 201);

  // Complete the steps (photo is set via the existing avatar flow)
  await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: 'https://example.test/avatar.jpg' } });
  await completeAllSteps(token, steps);

  r = await api('POST', '/api/worker/onboarding/submit', { token, json: { declaration: false } });
  assert.equal(r.status, 400, 'declaration is required');
  r = await api('POST', '/api/worker/onboarding/submit', { token, json: { declaration: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'PENDING');

  const profile = await prisma.workerProfile.findUnique({ where: { userId: user.id }, include: { skills: true, availabilities: true, additionalCategories: true } });
  assert.equal(profile.primaryCategoryId, electrician);
  assert.equal(profile.city, 'Belagavi');
  assert.deepEqual(profile.languages.sort(), ['English', 'Kannada']);
  assert.equal(profile.skills.length, 2);
  assert.equal(profile.availabilities.length, 5);
  assert.equal(profile.additionalCategories[0].categoryId, plumber);
  assert.equal(Number(profile.hourlyRate), 450);
  assert.equal(profile.verificationStatus, 'PENDING_REVIEW');
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).isEmailVerified, true, 'email flag untouched');

  // Locked while under review
  r = await api('PUT', '/api/worker/onboarding/step/2', { token, json: { data: steps[2], complete: false } });
  assert.equal(r.status, 409);
  r = await upload(token, 'GOVT_ID_PAN', PNG);
  assert.equal(r.status, 409);

  // An unverified worker has no public profile; the worker themself can still see it
  r = await api('GET', `/api/users/workers/${user.id}`);
  assert.equal(r.status, 404);
  r = await api('GET', `/api/users/workers/${user.id}`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.worker.isVerified, false);
});

// ── Authorization ────────────────────────────────────────────────────────────

test('authorization: only workers use /worker, only admins use review + document URLs', async () => {
  const { user: w, token: wt } = await makeUser('authw', 'WORKER');
  const { token: ct } = await makeUser('authc', 'CUSTOMER');
  const { token: at } = await makeUser('authadmin', 'ADMIN');
  assert.equal((await api('GET', '/api/worker/onboarding')).status, 401);
  assert.equal((await api('GET', '/api/worker/onboarding', { token: ct })).status, 403);
  assert.equal((await api('GET', '/api/worker/dashboard', { token: ct })).status, 403);
  assert.equal((await api('GET', '/api/admin/worker-verifications', { token: wt })).status, 403);
  assert.equal((await api('GET', '/api/admin/worker-verifications', { token: ct })).status, 403);
  assert.equal((await api('GET', '/api/admin/worker-verifications')).status, 401);
  assert.equal((await api('POST', `/api/admin/worker-verifications/${w.id}/approve`, { token: wt })).status, 403);
  assert.equal((await api('GET', '/api/admin/worker-verifications', { token: at })).status, 200);

  // Another worker cannot remove or discover someone else's document
  const { token: other } = await makeUser('authother', 'WORKER');
  const up = await upload(wt, 'GOVT_ID_OTHER', PNG);
  assert.equal(up.status, 201);
  assert.equal((await api('DELETE', `/api/worker/onboarding/documents/${up.data.document.id}`, { token: other })).status, 404);
  const doc = await prisma.workerDocument.findUnique({ where: { id: up.data.document.id } });
  assert.equal(doc.isCurrent, true);
  // The worker's own document list never contains a URL or a path
  const mine = await api('GET', '/api/worker/onboarding', { token: wt });
  assert.ok(!JSON.stringify(mine.data).includes('storagePath') && !JSON.stringify(mine.data).includes('storage.test'));
});

// ── Admin review: approve / reject / resubmit ────────────────────────────────

async function submittedWorker(label, steps) {
  const { user, token } = await makeUser(label, 'WORKER', { avatarUrl: 'https://example.test/a.jpg' });
  await completeAllSteps(token, steps).catch(async () => {
    await upload(token, 'GOVT_ID_PASSPORT', PNG);
    await completeAllSteps(token, steps);
  });
  return { user, token };
}

test('admin: review queue, signed document access, approval gates, approve → verified badge, audit trail', async () => {
  const cats = (await api('GET', '/api/categories')).data.categories;
  const steps = validSteps(cats.find((c) => c.name === 'Carpenter').id);
  const { user, token } = await makeUser('approve', 'WORKER', { avatarUrl: 'https://example.test/a.jpg' });
  const idUp = await upload(token, 'GOVT_ID_DRIVING_LICENCE', PNG);
  const certUp = await upload(token, 'PROFESSIONAL_CERTIFICATE', PDF, { name: 'c.pdf', mime: 'application/pdf' });
  await completeAllSteps(token, steps);
  assert.equal((await api('POST', '/api/worker/onboarding/submit', { token, json: { declaration: true } })).status, 200);
  const { user: admin, token: at } = await makeUser('approveadmin', 'ADMIN');

  // queue
  let r = await api('GET', '/api/admin/worker-verifications?q=' + encodeURIComponent(tag + '.approve'), { token: at });
  assert.equal(r.status, 200);
  assert.equal(r.data.submissions.length, 1);
  assert.equal(r.data.submissions[0].status, 'PENDING');
  assert.equal(r.data.submissions[0].category, 'Carpenter');

  // detail has profile + documents, no storage internals
  r = await api('GET', `/api/admin/worker-verifications/${user.id}`, { token: at });
  assert.equal(r.status, 200);
  assert.equal(r.data.submission.profile.profession, 'Carpenter');
  assert.equal(r.data.submission.documents.length, 2);
  assert.ok(!JSON.stringify(r.data).includes('storagePath'));
  assert.equal(r.data.submission.canApprove, false);

  // cannot approve before documents are reviewed
  r = await api('POST', `/api/admin/worker-verifications/${user.id}/approve`, { token: at, json: {} });
  assert.equal(r.status, 409);
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: user.id } })).verificationStatus, 'PENDING_REVIEW');

  // signed URL: short-lived, audit logged
  r = await api('GET', `/api/admin/worker-verifications/${user.id}/documents/${idUp.data.document.id}/url`, { token: at });
  assert.equal(r.status, 200);
  assert.match(r.data.url, /^https:\/\/storage\.test\/sign\/worker-documents\//);
  assert.ok(r.data.expiresInSeconds <= 300);
  assert.equal(await prisma.auditLog.count({ where: { action: 'WORKER_DOCUMENT_VIEWED', userId: admin.id } }), 1);
  assert.equal((await api('GET', `/api/admin/worker-verifications/${user.id}/documents/not-a-doc/url`, { token: at })).status, 404);

  // document decisions (reason required for non-verified)
  r = await api('PATCH', `/api/admin/worker-verifications/${user.id}/documents/${idUp.data.document.id}`, { token: at, json: { status: 'REJECTED' } });
  assert.equal(r.status, 400);
  r = await api('PATCH', `/api/admin/worker-verifications/${user.id}/documents/${idUp.data.document.id}`, { token: at, json: { status: 'VERIFIED' } });
  assert.equal(r.status, 200);
  assert.equal((await prisma.workerOnboarding.findUnique({ where: { userId: user.id } })).status, 'UNDER_REVIEW', 'first review action starts the review');
  r = await api('POST', `/api/admin/worker-verifications/${user.id}/approve`, { token: at, json: {} });
  assert.equal(r.status, 409, 'certificate still pending');
  await api('PATCH', `/api/admin/worker-verifications/${user.id}/documents/${certUp.data.document.id}`, { token: at, json: { status: 'VERIFIED' } });

  r = await api('POST', `/api/admin/worker-verifications/${user.id}/approve`, { token: at, json: { notes: 'Documents checked' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: user.id } })).verificationStatus, 'VERIFIED');
  assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).verificationStatus, 'VERIFIED');

  // badge visibility through the public worker endpoint
  r = await api('GET', `/api/users/workers/${user.id}`);
  assert.equal(r.data.worker.isVerified, true);

  // history + audit + notification
  r = await api('GET', `/api/admin/worker-verifications/${user.id}`, { token: at });
  const actions = r.data.submission.history.map((e) => e.action);
  for (const a of ['SUBMITTED', 'REVIEW_STARTED', 'DOCUMENT_VERIFIED', 'APPROVED']) assert.ok(actions.includes(a), `history has ${a}`);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'WORKER_VERIFIED', userId: admin.id } }));
  assert.ok(await prisma.notification.findFirst({ where: { userId: user.id, title: 'You are verified' } }));

  // verified workers cannot be re-approved or have their application edited
  assert.equal((await api('POST', `/api/admin/worker-verifications/${user.id}/approve`, { token: at, json: {} })).status, 409);
  assert.equal((await api('PUT', '/api/worker/onboarding/step/2', { token, json: { data: steps[2], complete: false } })).status, 409);
});

test('admin: reject needs a reason, then worker may resubmit; resubmission request flags documents and is tracked', async () => {
  const cats = (await api('GET', '/api/categories')).data.categories;
  const steps = validSteps(cats.find((c) => c.name === 'Painter').id);
  const { token: at } = await makeUser('rejadmin', 'ADMIN');

  // --- rejection
  const rej = await makeUser('reject', 'WORKER', { avatarUrl: 'https://example.test/a.jpg' });
  await upload(rej.token, 'GOVT_ID_VOTER_ID', PNG);
  await completeAllSteps(rej.token, steps);
  await api('POST', '/api/worker/onboarding/submit', { token: rej.token, json: { declaration: true } });
  let r = await api('POST', `/api/admin/worker-verifications/${rej.user.id}/reject`, { token: at, json: { reason: 'no' } });
  assert.equal(r.status, 400);
  r = await api('POST', `/api/admin/worker-verifications/${rej.user.id}/reject`, { token: at, json: { reason: 'Photo ID is unreadable and does not match the profile name.' } });
  assert.equal(r.status, 200);
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: rej.user.id } })).verificationStatus, 'REJECTED');
  r = await api('GET', '/api/worker/onboarding', { token: rej.token });
  assert.equal(r.data.onboarding.status, 'REJECTED');
  assert.match(r.data.onboarding.decisionReason, /unreadable/);
  assert.equal(r.data.onboarding.canEdit, true, 'rejected workers can fix and resubmit');
  assert.equal((await api('GET', `/api/users/workers/${rej.user.id}`)).status, 404, 'rejected workers are not public');
  assert.equal((await api('POST', `/api/admin/worker-verifications/${rej.user.id}/reject`, { token: at, json: { reason: 'Second rejection attempt' } })).status, 409);

  // --- resubmission
  const rs = await makeUser('resub', 'WORKER', { avatarUrl: 'https://example.test/a.jpg' });
  const idDoc = await upload(rs.token, 'GOVT_ID_PAN', PNG);
  await completeAllSteps(rs.token, steps);
  await api('POST', '/api/worker/onboarding/submit', { token: rs.token, json: { declaration: true } });
  r = await api('POST', `/api/admin/worker-verifications/${rs.user.id}/request-resubmission`, { token: at, json: { reason: 'Upload a clearer scan of your PAN card.', documentIds: [idDoc.data.document.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('GET', '/api/worker/onboarding', { token: rs.token });
  assert.equal(r.data.onboarding.status, 'RESUBMISSION_REQUIRED');
  assert.equal(r.data.onboarding.documents[0].status, 'RESUBMISSION_REQUIRED');
  assert.match(r.data.onboarding.documents[0].rejectionReason, /clearer scan/);

  // can't resubmit while the flagged document is still there
  r = await api('POST', '/api/worker/onboarding/submit', { token: rs.token, json: { declaration: true } });
  assert.equal(r.status, 400);
  assert.ok(r.data.problems.some((p) => p.field === 'documents' || p.field === 'identity'));

  // replace it, edit a field, resubmit
  assert.equal((await api('DELETE', `/api/worker/onboarding/documents/${idDoc.data.document.id}`, { token: rs.token })).status, 200);
  const replacement = await upload(rs.token, 'GOVT_ID_PAN', PNG, { name: 'clear.png' });
  assert.equal(replacement.status, 201);
  r = await api('PUT', '/api/worker/onboarding/step/1', { token: rs.token, json: { data: { ...steps[1], locality: 'Camp' }, complete: true } });
  assert.equal(r.status, 200);
  r = await api('POST', '/api/worker/onboarding/submit', { token: rs.token, json: { declaration: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ob1 = await prisma.workerOnboarding.findUnique({ where: { userId: rs.user.id } });
  assert.equal(ob1.status, 'PENDING');
  assert.equal(ob1.attemptCount, 2);
  assert.equal((await prisma.workerProfile.findUnique({ where: { userId: rs.user.id } })).locality, 'Camp');
  // old file is retained for the audit trail, just no longer current
  const oldDoc = await prisma.workerDocument.findUnique({ where: { id: idDoc.data.document.id } });
  assert.equal(oldDoc.isCurrent, false);
  assert.ok(objects.has(`worker-documents/${oldDoc.storagePath}`));

  r = await api('GET', `/api/admin/worker-verifications/${rs.user.id}`, { token: at });
  const actions = r.data.submission.history.map((e) => e.action);
  for (const a of ['SUBMITTED', 'RESUBMISSION_REQUESTED', 'DOCUMENT_REMOVED', 'RESUBMITTED']) assert.ok(actions.includes(a), `history has ${a}: ${actions}`);
  assert.equal(r.data.submission.attemptCount, 2);

  // admin cannot request resubmission for a draft/unsubmitted worker
  const draftOnly = await makeUser('draftonly', 'WORKER');
  assert.equal((await api('POST', `/api/admin/worker-verifications/${draftOnly.user.id}/request-resubmission`, { token: at, json: { reason: 'Please complete everything' } })).status, 404);
});

// ── Existing workers & dashboard ─────────────────────────────────────────────

test('existing worker compatibility and the dashboard shows only real data', async () => {
  const cats = (await api('GET', '/api/categories')).data.categories;
  const cleaner = cats.find((c) => c.name === 'Cleaner').id;

  // A pre-onboarding worker: profile exists, no onboarding record
  const legacy = await makeUser('legacy', 'WORKER', { avatarUrl: 'https://example.test/a.jpg' });
  await prisma.workerProfile.create({
    data: { userId: legacy.user.id, primaryCategoryId: cleaner, bio: 'Experienced home cleaner with a decade of work.', experienceYears: 10, hourlyRate: 300, verificationStatus: 'VERIFIED', skills: { create: [{ skillName: 'Deep cleaning' }] } }
  });
  let r = await api('GET', '/api/worker/status', { token: legacy.token });
  assert.equal(r.data.state, 'LEGACY_PROFILE');
  assert.equal(r.data.verificationStatus, 'VERIFIED');
  r = await api('GET', '/api/worker/onboarding', { token: legacy.token });
  assert.equal(r.data.onboarding.draft.professional.categoryId, cleaner, 'pre-filled from the existing profile');
  assert.deepEqual(r.data.onboarding.draft.professional.skills, ['Deep cleaning']);
  assert.equal(r.data.onboarding.canEdit, false, 'admin-verified legacy workers are not pushed back through review');
  assert.equal((await api('PUT', '/api/worker/onboarding/step/1', { token: legacy.token, json: { data: {}, complete: false } })).status, 409);
  // the original profile endpoint keeps working
  r = await api('PUT', '/api/users/profile', { token: legacy.token, json: { hourlyRate: 350, bio: 'Updated bio' } });
  assert.equal(r.status, 200);
  assert.equal(Number((await prisma.workerProfile.findUnique({ where: { userId: legacy.user.id } })).hourlyRate), 350);

  // Dashboard with nothing: zeros and empties, nothing fabricated
  r = await api('GET', '/api/worker/dashboard', { token: legacy.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.verification.isVerified, true);
  assert.deepEqual(r.data.upcomingBookings, []);
  assert.equal(r.data.earnings.totalEarnings, 0);
  assert.equal(r.data.earnings.availableBalance, 0);
  assert.equal(r.data.earnings.pendingSettlements, 0);
  assert.equal(r.data.reviews.count, 0);
  assert.equal(r.data.reviews.average, null);
  assert.ok(r.data.completion.percent > 0 && r.data.completion.percent < 100);

  // With real records
  const customer = await makeUser('dashcust', 'CUSTOMER');
  const booking = await prisma.booking.create({
    data: { bookingNumber: `BK-${tag}-1`, customerId: customer.user.id, workerId: legacy.user.id, status: 'CONFIRMED', scheduledAt: new Date(Date.now() + 86400000), agreedPrice: 800 }
  });
  const done = await prisma.booking.create({
    data: { bookingNumber: `BK-${tag}-2`, customerId: customer.user.id, workerId: legacy.user.id, status: 'COMPLETED', scheduledAt: new Date(Date.now() - 86400000), agreedPrice: 1000 }
  });
  const payment = await prisma.payment.create({
    data: { paymentNumber: `PAY-${tag}-2`, bookingId: done.id, customerId: customer.user.id, workerId: legacy.user.id, serviceAmount: 1000, platformFee: 50, taxAmount: 9, totalAmount: 1059, state: 'CAPTURED', capturedAt: new Date() }
  });
  await prisma.workerSettlement.create({
    data: { paymentId: payment.id, bookingId: done.id, workerId: legacy.user.id, serviceAmount: 1000, commissionRate: 5, commission: 50, netAmount: 950, status: 'ELIGIBLE', eligibleAt: new Date() }
  });
  await prisma.review.create({ data: { bookingId: done.id, customerId: customer.user.id, workerId: legacy.user.id, rating: 4, comment: 'Good work' } });
  r = await api('GET', '/api/worker/dashboard', { token: legacy.token });
  assert.equal(r.data.upcomingBookings.length, 1);
  assert.equal(r.data.upcomingBookings[0].id, booking.id);
  assert.equal(r.data.earnings.totalEarnings, 950, 'from the settlement record, after commission');
  assert.equal(r.data.earnings.availableBalance, 950);
  assert.equal(r.data.earnings.platformCommission, 50);
  assert.equal(r.data.earnings.completedJobs, 1);
  assert.equal(r.data.reviews.count, 1);
  assert.equal(r.data.reviews.average, 4);
  // other workers' earnings never leak in
  const stranger = await makeUser('dashstranger', 'WORKER');
  r = await api('GET', '/api/worker/dashboard', { token: stranger.token });
  assert.equal(r.data.earnings.totalEarnings, 0);
  assert.equal(r.data.hasProfile, false);
  assert.equal(r.data.completion.percent, 10 /* only the pre-set phone */);

  // Existing bookings/worker records are untouched by onboarding tables
  assert.equal(await prisma.booking.count({ where: { workerId: legacy.user.id } }), 2);
  await prisma.review.deleteMany({ where: { workerId: legacy.user.id } });
  await prisma.workerSettlement.deleteMany({ where: { workerId: legacy.user.id } });
  await prisma.payment.deleteMany({ where: { workerId: legacy.user.id } });
  await prisma.booking.deleteMany({ where: { workerId: legacy.user.id } });
});
