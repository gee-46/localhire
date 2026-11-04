// Profile photos.
//
// Why this file changed: the previous version called the Supabase Storage SDK directly with fake bytes and asserted
// a LIVE bucket. It never exercised LocalHire's own upload endpoint, and it failed on every machine without hosted
// Supabase credentials (four failures: "supabaseAdmin client must be initialized"). It is now two honest parts:
//
//   1. LOCAL tests (always run): the real HTTP endpoint POST /api/users/avatar against real Express + PostgreSQL, with a
//      recording in-memory storage double standing in for Supabase. These prove LocalHire's own validation and access
//      rules. They say nothing about the hosted bucket.
//   2. HOSTED test (runs only when SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are set): runs
//      scripts/verify-worker-storage.js against the real project (bucket privacy, limits, signed URLs, anonymous
//      access). Without credentials it is SKIPPED and reported as such, never passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');

const tag = `pp${Date.now()}`;
const created = [];
const realAdmin = supabaseConfig.supabaseAdmin;
const calls = []; let failUpload = false;
const fakeStorage = {
  storage: {
    from: (bucket) => ({
      upload: async (p, body, opts) => {
        calls.push({ bucket, path: p, bytes: body.length, opts });
        return failUpload ? { error: { message: 'SECRET provider detail: bucket policy xyz' } } : { error: null };
      },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://storage.example.test/object/public/${bucket}/${p}` } })
    })
  }
};

// Real file signatures (the app identifies files by their bytes, not by the declared type)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(100, 1)]);

let base;
async function upload(token, bytes, { type = 'image/png', name = 'a.png', field = 'avatar' } = {}) {
  const form = new FormData();
  if (bytes) form.append(field, new Blob([bytes], { type }), name);
  const res = await fetch(`${base}/api/users/avatar`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
  let data = null; try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}
async function makeUser(label, role = 'CUSTOMER') {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}

test.before(async () => {
  supabaseConfig.supabaseAdmin = fakeStorage;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  supabaseConfig.supabaseAdmin = realAdmin;
  await prisma.workerProfile.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('LOCAL: avatar upload requires a signed-in user and a file', async () => {
  const u = await makeUser('auth');
  const before = calls.length;
  assert.equal((await upload(null, PNG)).status, 401, 'no token');
  assert.equal((await upload('garbage.token.value', PNG)).status, 401, 'bad token');
  const none = await upload(u.token, null); assert.equal(none.status, 400);
  const wrongField = await upload(u.token, PNG, { field: 'file' }); assert.equal(wrongField.status, 400, 'unexpected field name');
  assert.equal(calls.length, before, 'nothing reached storage');
  assert.equal((await prisma.user.findUnique({ where: { id: u.user.id } })).avatarUrl, null);
});

test('LOCAL: a customer photo is validated by its bytes, stored under the user\'s own path, and can be replaced', async () => {
  const u = await makeUser('cust');
  const r1 = await upload(u.token, PNG);
  assert.equal(r1.status, 200, JSON.stringify(r1.data)); assert.equal(r1.data.success, true);
  const c1 = calls[calls.length - 1];
  assert.equal(c1.bucket, 'profile-photos'); assert.ok(c1.path.startsWith(`${u.user.id}/avatar-`) && c1.path.endsWith('.png'), c1.path);
  assert.equal(c1.opts.contentType, 'image/png');
  assert.equal((await prisma.user.findUnique({ where: { id: u.user.id } })).avatarUrl, r1.data.avatarUrl);

  // declared type lies: a JPEG sent as image/png is stored as what it really is
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await upload(u.token, JPEG, { type: 'image/png', name: 'x.png' });
  assert.equal(r2.status, 200); const c2 = calls[calls.length - 1];
  assert.equal(c2.opts.contentType, 'image/jpeg'); assert.ok(c2.path.endsWith('.jpg'));
  assert.notEqual(r2.data.avatarUrl, r1.data.avatarUrl, 'replacement changes the stored photo');
  const r3 = await upload(u.token, WEBP, { type: 'image/webp', name: 'x.webp' });
  assert.equal(r3.status, 200); assert.ok(calls[calls.length - 1].path.endsWith('.webp'));
  assert.ok(!JSON.stringify(r3.data).includes('passwordHash'));
});

test('LOCAL: files that are not real JPG/PNG/WebP images are refused even when they claim to be', async () => {
  const u = await makeUser('bad');
  const before = calls.length;
  const attempts = [
    ['fake bytes labelled jpeg (what the old test uploaded)', Buffer.from('fake-jpeg-binary-content-for-testing'), 'image/jpeg', 'a.jpg'],
    ['HTML labelled png', Buffer.from('<html><script>alert(1)</script></html>        '), 'image/png', 'a.png'],
    ['SVG labelled webp', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), 'image/webp', 'a.webp'],
    ['PDF labelled jpeg', Buffer.from('%PDF-1.7 fake pdf body here'), 'image/jpeg', 'a.jpg'],
    ['empty-ish file', Buffer.from('x'), 'image/png', 'a.png']
  ];
  for (const [label, bytes, type, name] of attempts) {
    const r = await upload(u.token, bytes, { type, name });
    assert.equal(r.status, 400, label); assert.match(r.data.message, /valid JPG, PNG or WebP/i, label);
  }
  assert.equal((await upload(u.token, Buffer.from('plain text'), { type: 'text/plain', name: 'a.txt' })).status, 400, 'declared type refused up front');
  assert.equal((await upload(u.token, Buffer.from('GIF89a......'), { type: 'image/gif', name: 'a.gif' })).status, 400, 'gif not allowed');
  assert.equal(calls.length, before, 'none of them reached storage');
  assert.equal((await prisma.user.findUnique({ where: { id: u.user.id } })).avatarUrl, null);
});

test('LOCAL: size limit is 5 MB', async () => {
  const u = await makeUser('big');
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10, 1)]);
  const r = await upload(u.token, big); assert.equal(r.status, 400); assert.match(r.data.message, /5 MB/);
  const ok = Buffer.concat([PNG, Buffer.alloc(1024 * 1024, 1)]);
  assert.equal((await upload(u.token, ok)).status, 200, '1 MB is fine');
});

test('LOCAL: a professional keeps their profile, and one user can never write to another user\'s photo', async () => {
  const cat = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  const w = await makeUser('wk', 'WORKER');
  await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: cat.id, hourlyRate: 300, verificationStatus: 'VERIFIED' } });
  const victim = await makeUser('victim');
  const r = await upload(w.token, PNG);
  assert.equal(r.status, 200); assert.ok(await prisma.workerProfile.findUnique({ where: { userId: w.user.id } }), 'WorkerProfile intact');
  assert.ok(calls[calls.length - 1].path.startsWith(`${w.user.id}/`), 'path comes from the session, not the request');
  // there is no way to name another user: a userId in the form or query is ignored
  const form = new FormData(); form.append('avatar', new Blob([PNG], { type: 'image/png' }), 'a.png'); form.append('userId', victim.user.id);
  const res = await fetch(`${base}/api/users/avatar?userId=${victim.user.id}`, { method: 'POST', headers: { Authorization: `Bearer ${w.token}` }, body: form });
  assert.equal(res.status, 200);
  assert.ok(calls[calls.length - 1].path.startsWith(`${w.user.id}/`));
  assert.equal((await prisma.user.findUnique({ where: { id: victim.user.id } })).avatarUrl, null, 'victim untouched');
  // removing a photo only affects the caller
  assert.equal((await fetch(`${base}/api/users/avatar`, { method: 'DELETE', headers: { Authorization: `Bearer ${w.token}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/users/avatar`, { method: 'DELETE' })).status, 401);
});

test('LOCAL: storage problems are reported without leaking provider details', async () => {
  const u = await makeUser('fail');
  failUpload = true;
  const r = await upload(u.token, PNG);
  failUpload = false;
  assert.equal(r.status, 502); assert.ok(!JSON.stringify(r.data).includes('SECRET'), 'provider error text is not returned');
  assert.equal((await prisma.user.findUnique({ where: { id: u.user.id } })).avatarUrl, null, 'no photo saved when storage failed');
  supabaseConfig.supabaseAdmin = null;
  const off = await upload(u.token, PNG);
  supabaseConfig.supabaseAdmin = fakeStorage;
  assert.equal(off.status, 503); assert.match(off.data.message, /not configured/i);
});

// ── Hosted Supabase (needs real credentials) ─────────────────────────────────
const hostedConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY)
  && !/replace_with|your-project|your_/i.test(`${process.env.SUPABASE_URL}${process.env.SUPABASE_SERVICE_ROLE_KEY}`);
test('HOSTED: profile-photos and worker-documents buckets, signed URLs and anonymous access on the real Supabase project',
  { skip: hostedConfigured ? false : 'SKIPPED: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are not configured, so the hosted buckets cannot be verified here. Run `npm --prefix server run storage:verify` with real credentials.' },
  () => {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'verify-worker-storage.js')], { encoding: 'utf8', env: process.env, timeout: 120000 });
    assert.equal(r.status, 0, `storage verification failed:\n${r.stdout}\n${r.stderr}`);
  });
