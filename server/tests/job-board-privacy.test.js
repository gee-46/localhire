// Public job board privacy. Anonymous visitors (and anyone who is not the poster or an admin) must not be able to learn WHO
// posted a job: no name, no user id, no contact details, no precise location. This checks the API responses themselves
// (hiding fields in the UI alone would not be enough) and the source of the pages that render them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');

const tag = `jb${Date.now()}`;
const created = [];
let base; let cat; let poster; let other; let worker; let admin; let jobA; let jobB; let jobFlagged; let address;
const POSTER_NAME = `Meera Kulkarni ${tag}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const api = async (p, token) => {
  const res = await fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, data, text };
};
const makeUser = async (label, role, name) => {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: name || `${label} Person ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 91234 56789' } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
};

test.before(async () => {
  cat = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  poster = await makeUser('poster', 'CUSTOMER', POSTER_NAME); other = await makeUser('other', 'CUSTOMER'); worker = await makeUser('worker', 'WORKER'); admin = await makeUser('admin', 'ADMIN');
  address = await prisma.customerAddress.create({ data: { customerId: poster.user.id, street: '42 Private Lane', landmark: 'Behind the red gate', city: 'Belagavi', postalCode: '590006', latitude: 15.8497123, longitude: 74.4977456 } });
  const mk = (customerId, title, extra = {}) => prisma.jobPost.create({ data: { customerId, categoryId: cat.id, title: `${title} ${tag}`, description: 'Kitchen tap is leaking, need repair this week.', urgency: 'FLEXIBLE', status: 'OPEN', budgetMin: 300, budgetMax: 600, ...extra } });
  jobA = await mk(poster.user.id, 'Fix tap A', { addressId: address.id }); // even with an address attached, nothing precise may leave the server
  jobB = await mk(other.user.id, 'Fix tap B');
  jobFlagged = await mk(poster.user.id, 'Flagged', { isFlagged: true, flagReason: 'abuse' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await prisma.jobPost.deleteMany({ where: { customerId: { in: created } } }).catch(() => {});
  await prisma.customerAddress.deleteMany({ where: { customerId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  require('../services/trackingService').stopSweeper();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// What nobody but the poster / an admin may ever receive about the poster.
// `allow` exempts the viewer's OWN identity (a user may see their own name/id on their own job).
const assertNoIdentity = (res, label, { allow = [] } = {}) => {
  const everyone = [poster, other, worker, admin].filter((u) => !allow.includes(u));
  const body = res.text;
  assert.equal(res.status, 200, label);
  for (const u of everyone) {
    assert.ok(!body.includes(u.user.id), `${label}: contains user id of ${u.user.role}`);
    assert.ok(!body.includes(u.user.email), `${label}: contains an e-mail`);
    assert.ok(!body.includes(u.user.name), `${label}: contains the name "${u.user.name}"`);
  }
  assert.ok(!body.includes('91234') && !body.includes('56789'), `${label}: contains a phone number`);
  assert.ok(!body.includes('Private Lane') && !body.includes('red gate') && !body.includes('590006') && !body.includes('15.8497') && !body.includes('74.4977'), `${label}: contains a precise location`);
  assert.ok(!body.includes('Meera') && !body.includes('Kulkarni'), `${label}: contains the poster's name`);
  const walk = (v, trail = '') => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${trail}[${i}]`));
    if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => {
      assert.ok(!['customername', 'customerid', 'customer', 'email', 'phone', 'userid', 'avatarurl', 'latitude', 'longitude', 'street', 'postalcode', 'passwordhash'].includes(k.toLowerCase()), `${label}: private key "${trail}.${k}"`);
      walk(x, `${trail}.${k}`);
    });
  };
  if (!allow.length) walk(res.data); // a viewer's own job legitimately carries their own identity keys; callers check the rest explicitly
};
// The only UUIDs allowed in a public job response are job ids.
const uuidsIn = (text) => new Set((text.match(UUID) || []).map((x) => x.toLowerCase()));

test('anonymous visitors get the job details needed for discovery, with no customer identity or internal user ids', async () => {
  const list = await api('/api/jobs');
  assertNoIdentity(list, 'GET /api/jobs');
  const mine = list.data.jobs.find((j) => j.id === jobA.id);
  assert.ok(mine, 'the job is on the board');
  // discovery details are intact
  assert.equal(mine.title, `Fix tap A ${tag}`); assert.match(mine.description, /leaking/); assert.equal(mine.category, 'Plumber');
  assert.equal(mine.budget, '₹300 - ₹600'); assert.equal(mine.urgency, 'Flexible'); assert.equal(mine.status, 'Open'); assert.ok(mine.createdAt);
  assert.deepEqual(mine.location, { address: 'Local service request' }, 'coarse location only, even though the job has a full address on file');
  assert.equal(mine.isMine, false);
  assert.deepEqual(Object.keys(mine).sort(), ['_id', 'budget', 'category', 'createdAt', 'description', 'id', 'isMine', 'location', 'status', 'title', 'updatedAt', 'urgency']);
  // the only identifiers are job ids
  const allowed = new Set(list.data.jobs.flatMap((j) => [j.id, j._id]).map((x) => x.toLowerCase()));
  for (const u of uuidsIn(list.text)) assert.ok(allowed.has(u), `unexpected identifier ${u} in the job list`);

  const one = await api(`/api/jobs/${jobA.id}`);
  assertNoIdentity(one, 'GET /api/jobs/:id');
  assert.equal(one.data.job.title, `Fix tap A ${tag}`);
  for (const u of uuidsIn(one.text)) assert.equal(u, jobA.id.toLowerCase());
});

test('filters still work anonymously and cannot be used to find a customer by name', async () => {
  const byTitle = await api(`/api/jobs?q=${encodeURIComponent('Fix tap A ' + tag)}`);
  assertNoIdentity(byTitle, 'q=title'); assert.deepEqual(byTitle.data.jobs.map((j) => j.id), [jobA.id]);
  assert.ok((await api('/api/jobs?category=Plumber')).data.jobs.some((j) => j.id === jobA.id));
  assert.ok((await api('/api/jobs?status=open')).data.jobs.some((j) => j.id === jobA.id));
  for (const probe of [POSTER_NAME, 'Meera', 'Kulkarni', poster.user.email, poster.user.id, '91234']) {
    const r = await api(`/api/jobs?q=${encodeURIComponent(probe)}`);
    assertNoIdentity(r, `q=${probe}`); assert.equal(r.data.jobs.length, 0, `searching for "${probe}" must not find the poster's jobs`);
  }
  assert.equal((await api(`/api/jobs?q=${encodeURIComponent("' OR 1=1 --")}`)).status, 200);
});

test('administrator-flagged jobs stay hidden from the public', async () => {
  assert.ok(!(await api('/api/jobs')).data.jobs.some((j) => j.id === jobFlagged.id));
  assert.equal((await api(`/api/jobs/${jobFlagged.id}`)).status, 404);
});

test('invalid, expired, forged and revoked tokens are treated exactly like an anonymous visitor', async () => {
  const forged = jwt.sign({ id: admin.user.id, tv: 0 }, 'some-other-secret');
  const expired = jwt.sign({ id: poster.user.id, tv: 0 }, process.env.JWT_SECRET, { expiresIn: -10 });
  const staleVersion = jwt.sign({ id: poster.user.id, tv: 99 }, process.env.JWT_SECRET);
  for (const [label, token] of [['forged admin token', forged], ['expired owner token', expired], ['revoked (old tokenVersion) owner token', staleVersion], ['garbage', 'not.a.token']]) {
    const list = await api('/api/jobs', token); assertNoIdentity(list, label); assert.ok(list.data.jobs.every((j) => j.isMine === false), label);
    assertNoIdentity(await api(`/api/jobs/${jobA.id}`, token), `${label} (detail)`);
  }
  const suspended = await makeUser('suspended', 'CUSTOMER'); await prisma.user.update({ where: { id: suspended.user.id }, data: { isActive: false } });
  assertNoIdentity(await api(`/api/jobs/${jobA.id}`, suspended.token), 'suspended account');
});

test('signed-in users who are not the poster (other customers, professionals) see no poster identity either', async () => {
  for (const [label, who] of [['another customer', other], ['a professional', worker]]) {
    const mineOnly = who === other ? { allow: [other] } : {};
    const list = await api('/api/jobs', who.token); assertNoIdentity(list, label, mineOnly);
    assert.ok(!list.text.includes(poster.user.id) && !list.text.includes(POSTER_NAME), `${label}: the poster is not identified`);
    for (const j of list.data.jobs) if (!(who === other && j.id === jobB.id)) assert.ok(!('customerName' in j) && !('customerId' in j), `${label}: job ${j.id} carries a poster identity`);
    assert.ok(list.data.jobs.every((j) => j.isMine === false || (who === other && j.id === jobB.id)), `${label}: isMine only on own jobs`);
    assertNoIdentity(await api(`/api/jobs/${jobA.id}`, who.token), `${label} (detail)`);
  }
});

test('the poster still sees their own jobs (with their own name and id); other people\'s jobs stay anonymous to them', async () => {
  const list = await api('/api/jobs', poster.token);
  const own = list.data.jobs.find((j) => j.id === jobA.id); const foreign = list.data.jobs.find((j) => j.id === jobB.id);
  assert.equal(own.customerName, POSTER_NAME); assert.equal(own.customerId, poster.user.id); assert.equal(own.isMine, true);
  assert.ok(foreign && !('customerName' in foreign) && !('customerId' in foreign) && foreign.isMine === false, 'a customer does not learn who posted someone else\'s job');
  assert.ok(!list.text.includes(other.user.name) && !list.text.includes(other.user.id) && !list.text.includes(other.user.email));
  assert.ok(!list.text.includes('Private Lane') && !list.text.includes('590006'), 'not even the owner receives the address through the job board');
  const detail = await api(`/api/jobs/${jobA.id}`, poster.token); assert.equal(detail.data.job.customerName, POSTER_NAME); assert.equal(detail.data.job.isMine, true);
  const otherDetail = await api(`/api/jobs/${jobB.id}`, poster.token); assert.ok(!('customerName' in otherDetail.data.job));
  // the site's own "My Jobs" logic: filtering by ownership returns exactly the poster's jobs
  assert.deepEqual(list.data.jobs.filter((j) => j.isMine === true || j.customerId === poster.user.id).map((j) => j.id).sort(), [jobA.id].sort());
});

test('administrators keep full access to who posted a job', async () => {
  const list = await api('/api/jobs', admin.token);
  assert.equal(list.data.jobs.find((j) => j.id === jobA.id).customerName, POSTER_NAME);
  assert.equal(list.data.jobs.find((j) => j.id === jobB.id).customerId, other.user.id);
  assert.equal((await api(`/api/jobs/${jobA.id}`, admin.token)).data.job.customerId, poster.user.id);
  // the admin job moderation list is unchanged and still admin-only
  const adminJobs = await api('/api/admin/jobs?limit=100', admin.token);
  assert.equal(adminJobs.status, 200); assert.ok(JSON.stringify(adminJobs.data).includes(POSTER_NAME), 'admin moderation list still shows the customer');
  assert.equal((await api('/api/admin/jobs', poster.token)).status, 403); assert.equal((await api('/api/admin/jobs', worker.token)).status, 403); assert.equal((await api('/api/admin/jobs')).status, 401);
});

test('posting and changing a job still works for the poster and returns their own identity to them only', async () => {
  const post = (token, body) => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const made = await post(poster.token, { title: `New job ${tag}`, description: 'Need a plumber on Saturday', category: 'Plumber', budget: '400-500', urgency: 'This week' });
  assert.equal(made.status, 201); assert.equal(made.data.job.customerName, POSTER_NAME); assert.equal(made.data.job.customerId, poster.user.id);
  const publicView = await api(`/api/jobs/${made.data.job.id}`);
  assertNoIdentity(publicView, 'new job, public view'); assert.equal(publicView.data.job.title, `New job ${tag}`);
  const put = (token, id, status) => fetch(`${base}/api/jobs/${id}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  assert.equal((await put(other.token, made.data.job.id, 'CANCELLED')).status, 403, 'another customer cannot change it');
  const closed = await put(poster.token, made.data.job.id, 'CANCELLED');
  assert.equal(closed.status, 200); assert.equal(closed.data.job.status, 'Cancelled'); assert.equal(closed.data.job.customerName, POSTER_NAME);
  assert.equal((await put(admin.token, made.data.job.id, 'OPEN')).status, 200, 'admins can still manage it');
});

test('booking participants keep the access they legitimately need', async () => {
  const booking = await prisma.booking.create({ data: { bookingNumber: `BK-${tag}-1`, customerId: poster.user.id, workerId: worker.user.id, jobPostId: jobA.id, status: 'CONFIRMED', agreedPrice: 500, scheduledAt: new Date(Date.now() + 86400000), priceConfirmedAt: new Date() } });
  try {
    const asWorker = (await api('/api/bookings/my', worker.token)).data.bookings.find((b) => b.id === booking.id);
    assert.equal(asWorker.customer.name, POSTER_NAME, 'the professional on the booking still sees who the customer is');
    const asCustomer = (await api('/api/bookings/my', poster.token)).data.bookings.find((b) => b.id === booking.id);
    assert.equal(asCustomer.worker.name, worker.user.name);
    const stranger = (await api('/api/bookings/my', other.token)).data.bookings;
    assert.ok(!stranger.some((b) => b.id === booking.id), 'a stranger sees nothing of it');
    assert.equal((await api(`/api/bookings/${booking.id}`, other.token)).status, 403);
    // …and the public job board still hides the customer even though a booking exists for that job
    assertNoIdentity(await api(`/api/jobs/${jobA.id}`), 'job with a booking, public view');
  } finally { await prisma.booking.deleteMany({ where: { id: booking.id } }); }
});

// ── The rendering side ───────────────────────────────────────────────────────
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', rel), 'utf8');
test('page sources: nothing matches customers by name, and the public job card has no customer-name fallback', () => {
  const myJobs = read('pages/my-jobs.html'); const app = read('js/app.js'); const api = read('js/api.js');
  assert.ok(!/customerName\s*===\s*user\.name/.test(myJobs), 'My Jobs must not identify "my" jobs by comparing names');
  assert.ok(/j\.isMine === true/.test(myJobs));
  assert.ok(!/\$\{job\.customerName\}/.test(myJobs), 'no unescaped customer name interpolation');
  assert.ok(!/job\.customerName \|\| 'Client'/.test(app) && /job\.customerName \|\| 'a customer'/.test(app));
  assert.ok(/getStoredToken\(\)/.test(api.slice(api.indexOf('getJobs:'), api.indexOf('getJobs:') + 700)), 'the jobs call sends the token so owners keep their list');
});
