// Authorization of the job-applications (quotes) endpoints. Real Express + real PostgreSQL.
//   * Only the customer who posted a job, and admins, may list the complete applicant list.
//   * Everyone else (anonymous, other customers, professionals, even applicants) is refused, and a job that is someone
//     else's is indistinguishable from a job that does not exist.
//   * A professional reads their own quote status through GET /api/applications/worker/me and never sees other applicants.
//   * No response, authorized or not, carries applicant e-mails, phone numbers or other private fields.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');

const tag = `ap${Date.now()}`;
const created = [];
let base; let plumber;
let owner; let otherCustomer; let w1; let w2; let w3; let admin; let job; let otherJob; let app1; let app2;
const MSG1 = `Cover note one ${tag}`; const MSG2 = `Cover note two ${tag}`;
const MISSING = '00000000-0000-4000-8000-000000000000';

async function api(method, p, { token, json } = {}) {
  const headers = {}; if (token) headers.Authorization = `Bearer ${token}`;
  let body; if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + p, { method, headers, body });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, data, text };
}
async function makeUser(label, role) {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} Person ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: `+91 9${Math.floor(10000000 + Math.random() * 89999999)}` } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}
async function makeWorker(label) {
  const w = await makeUser(label, 'WORKER');
  await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus: 'VERIFIED', hourlyRate: 300, bio: 'Pro' } });
  return w;
}

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  owner = await makeUser('owner', 'CUSTOMER'); otherCustomer = await makeUser('othercust', 'CUSTOMER'); admin = await makeUser('admin', 'ADMIN');
  w1 = await makeWorker('w1'); w2 = await makeWorker('w2'); w3 = await makeWorker('w3');
  job = await prisma.jobPost.create({ data: { customerId: owner.user.id, categoryId: plumber.id, title: `Geyser ${tag}`, description: 'Replace the old geyser.' } });
  otherJob = await prisma.jobPost.create({ data: { customerId: otherCustomer.user.id, categoryId: plumber.id, title: `Other ${tag}`, description: 'Fix a door.' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // applications are created through the real endpoint, as the professionals would
  const a1 = await api('POST', '/api/applications', { token: w1.token, json: { jobId: job.id, quote: 1500, message: MSG1 } });
  const a2 = await api('POST', '/api/applications', { token: w2.token, json: { jobId: job.id, quote: 1800, message: MSG2 } });
  assert.equal(a1.status, 201, a1.text); assert.equal(a2.status, 201, a2.text);
  app1 = a1.data.application; app2 = a2.data.application;
});
test.after(async () => {
  await prisma.booking.deleteMany({ where: { OR: [{ customerId: { in: created } }, { workerId: { in: created } }] } }).catch(() => {});
  await prisma.jobApplication.deleteMany({ where: { jobId: { in: [job.id, otherJob.id] } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.jobPost.deleteMany({ where: { id: { in: [job.id, otherJob.id] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  require('../services/trackingService').stopSweeper();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// Nothing about the applicants may appear in a response the caller is not entitled to.
const assertNoApplicantData = (res, label) => {
  for (const w of [w1, w2, w3]) {
    assert.ok(!res.text.includes(w.user.email), `${label}: applicant e-mail`);
    assert.ok(!res.text.includes(w.user.phone.replace('+91 ', '')), `${label}: applicant phone`);
    assert.ok(!res.text.includes(w.user.id), `${label}: applicant user id`);
    assert.ok(!res.text.includes(w.user.name), `${label}: applicant name`);
  }
  assert.ok(!res.text.includes(MSG1) && !res.text.includes(MSG2), `${label}: cover message`);
  assert.ok(!/1500|1800/.test(res.text), `${label}: quote amount`);
  assert.ok(!res.text.includes(app1.id) && !res.text.includes(app2.id), `${label}: application id`);
};
// No private fields, whoever is looking (including the job owner and admins).
const assertNoPrivateFields = (res, label) => {
  const walk = (v, trail = '') => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${trail}[${i}]`));
    if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => {
      assert.ok(!['email', 'phone', 'passwordhash', 'tokenversion', 'supabaseauthid', 'role', 'latitude', 'longitude', 'address'].includes(k.toLowerCase()), `${label}: private key ${trail}.${k}`);
      walk(x, `${trail}.${k}`);
    });
  };
  walk(res.data);
  for (const w of [w1, w2, w3]) { assert.ok(!res.text.includes(w.user.email), `${label}: e-mail`); assert.ok(!res.text.includes(w.user.phone.replace('+91 ', '')), `${label}: phone`); }
};

test('anonymous callers are denied on every application route', async () => {
  for (const [m, p, body] of [['GET', `/api/applications/job/${job.id}`], ['GET', '/api/applications/worker/me'], ['POST', '/api/applications', { jobId: job.id, quote: 1, message: 'x' }], ['PUT', `/api/applications/${app1.id}/accept`, {}]]) {
    const res = await api(m, p, { json: body });
    assert.equal(res.status, 401, `${m} ${p}`); assertNoApplicantData(res, `${m} ${p}`);
  }
});

test('an unrelated customer is denied, and the answer is identical to asking about a job that does not exist', async () => {
  const mine = await api('GET', `/api/applications/job/${job.id}`, { token: otherCustomer.token });
  const missing = await api('GET', `/api/applications/job/${MISSING}`, { token: otherCustomer.token });
  const garbage = await api('GET', '/api/applications/job/not-a-real-id', { token: otherCustomer.token });
  assert.equal(mine.status, 404); assertNoApplicantData(mine, 'unrelated customer');
  assert.equal(mine.status, missing.status); assert.equal(mine.text, missing.text, 'someone else\'s job is indistinguishable from a missing one');
  assert.equal(garbage.status, 404); assert.equal(garbage.text, missing.text);
  assert.ok(!mine.text.includes(owner.user.id) && !mine.text.includes(owner.user.name), 'no hint of who owns it');
  // …and the same customer still sees THEIR OWN job's (empty) applicant list
  const own = await api('GET', `/api/applications/job/${otherJob.id}`, { token: otherCustomer.token });
  assert.equal(own.status, 200); assert.deepEqual(own.data.applications, []);
});

test('professionals are denied the complete applicant list, including an applicant and for any job id', async () => {
  const ids = [job.id, otherJob.id, MISSING, 'not-a-real-id'];
  const bodies = new Set();
  for (const [label, who] of [['applicant w1', w1], ['applicant w2', w2], ['professional who did not apply', w3]]) {
    for (const id of ids) {
      const res = await api('GET', `/api/applications/job/${id}`, { token: who.token });
      assert.equal(res.status, 403, `${label} ${id}`); assertNoApplicantData(res, `${label} ${id}`); bodies.add(res.text);
    }
  }
  assert.equal(bodies.size, 1, 'the refusal is the same for an existing and a missing job, so nothing about job ownership leaks');
});

test('the job owner gets the complete applicant list, without applicant contact details', async () => {
  const res = await api('GET', `/api/applications/job/${job.id}`, { token: owner.token });
  assert.equal(res.status, 200); assert.equal(res.data.count, 2);
  const byWorker = Object.fromEntries(res.data.applications.map((a) => [a.workerId, a]));
  assert.equal(byWorker[w1.user.id].quote, 1500); assert.equal(byWorker[w1.user.id].message, MSG1); assert.equal(byWorker[w1.user.id].workerName, w1.user.name); assert.equal(byWorker[w1.user.id].status, 'Pending');
  assert.equal(byWorker[w2.user.id].quote, 1800); assert.equal(byWorker[w2.user.id].message, MSG2);
  assert.deepEqual(Object.keys(res.data.applications[0]).sort(), ['id', 'jobId', 'message', 'quote', 'status', 'workerAvatar', 'workerId', 'workerName']);
  assertNoPrivateFields(res, 'owner');
});

test('an administrator gets the complete applicant list for any job, without contact details', async () => {
  const res = await api('GET', `/api/applications/job/${job.id}`, { token: admin.token });
  assert.equal(res.status, 200); assert.equal(res.data.count, 2); assertNoPrivateFields(res, 'admin');
  assert.equal((await api('GET', `/api/applications/job/${otherJob.id}`, { token: admin.token })).status, 200);
  const missing = await api('GET', `/api/applications/job/${MISSING}`, { token: admin.token });
  assert.equal(missing.status, 404, 'a job that does not exist is a 404 for admins too');
});

test('a professional can read their own quote status, and only their own', async () => {
  const mine = await api('GET', '/api/applications/worker/me', { token: w1.token });
  assert.equal(mine.status, 200); assert.equal(mine.data.count, 1);
  const a = mine.data.applications[0];
  assert.equal(a.id, app1.id); assert.equal(a.jobId, job.id); assert.equal(a.quote, 1500); assert.equal(a.status, 'Pending'); assert.equal(a.jobTitle, `Geyser ${tag}`);
  assert.ok(!mine.text.includes(MSG2) && !mine.text.includes(w2.user.id) && !mine.text.includes(w2.user.name) && !mine.text.includes(app2.id), 'no other applicant\'s record');
  assertNoPrivateFields(mine, 'worker/me');
  const none = await api('GET', '/api/applications/worker/me', { token: w3.token });
  assert.equal(none.status, 200); assert.equal(none.data.count, 0);
  assert.equal((await api('GET', '/api/applications/worker/me', { token: owner.token })).status, 403, 'customers have no quotes to list here');
  // the application the professional just created contains no e-mail either
  const created1 = await api('POST', '/api/applications', { token: w3.token, json: { jobId: otherJob.id, quote: 700, message: `w3 note ${tag}` } });
  assert.equal(created1.status, 201); assertNoPrivateFields(created1, 'POST /api/applications');
  assert.equal((await api('POST', '/api/applications', { token: w3.token, json: { jobId: otherJob.id, quote: 700, message: 'again' } })).status, 400, 'one quote per job still enforced');
});

test('accepting a quote keeps working for the owner and admins, and is refused to everyone else without leaking applicant data', async () => {
  const stranger = await api('PUT', `/api/applications/${app1.id}/accept`, { token: otherCustomer.token });
  assert.equal((await api('PUT', `/api/applications/${MISSING}/accept`, { token: otherCustomer.token })).status, 404, 'a quote that does not exist is a 404');
  assert.equal(stranger.status, 403, 'unchanged contract: another customer cannot accept a quote on another customer job');
  assertNoApplicantData(stranger, 'accept by stranger');
  assert.equal((await api('PUT', `/api/applications/${app1.id}/accept`, { token: w1.token })).status, 403, 'professionals cannot accept');
  assert.equal((await api('PUT', `/api/applications/${app1.id}/accept`, { token: w2.token })).status, 403);
  assert.equal((await prisma.jobApplication.findUnique({ where: { id: app1.id } })).status, 'PENDING', 'nothing changed');

  const ok = await api('PUT', `/api/applications/${app1.id}/accept`, { token: owner.token });
  assert.equal(ok.status, 200, ok.text); assert.ok(ok.data.bookingId); assert.equal(ok.data.application.status, 'Accepted'); assertNoPrivateFields(ok, 'accept by owner');
  const booking = await prisma.booking.findUnique({ where: { id: ok.data.bookingId } });
  assert.equal(booking.customerId, owner.user.id); assert.equal(booking.workerId, w1.user.id); assert.equal(booking.status, 'CONFIRMED'); assert.equal(Number(booking.agreedPrice), 1500);

  // the professionals' own status endpoint reflects the outcome, each seeing only their own row
  assert.equal((await api('GET', '/api/applications/worker/me', { token: w1.token })).data.applications[0].status, 'Accepted');
  const w2view = await api('GET', '/api/applications/worker/me', { token: w2.token });
  assert.equal(w2view.data.applications[0].status, 'Pending'); assert.ok(!w2view.text.includes(w1.user.name) && !w2view.text.includes(app1.id));
  // admin acceptance of another job's quote still works
  const adminOk = await api('PUT', `/api/applications/${(await prisma.jobApplication.findFirst({ where: { jobId: otherJob.id } })).id}/accept`, { token: admin.token });
  assert.equal(adminOk.status, 200, adminOk.text);
  // the owner's list now shows the accepted status
  assert.equal((await api('GET', `/api/applications/job/${job.id}`, { token: owner.token })).data.applications.find((a) => a.id === app1.id).status, 'Accepted');
});
