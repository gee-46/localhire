// Phase 9: production readiness. Everything here runs locally (real Express, real PostgreSQL, real child processes).
// Nothing in this file talks to Supabase, Razorpay or a push service; the report keeps that distinction.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const webpush = require('web-push');
const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { validateEnv, enforce, parseTrustProxy } = require('../config/env');
const { app, server } = require('../server');

const tag = `pr${Date.now()}`;
const created = [];
let base;

// ── A realistic, valid production environment (no real credentials; shapes only) ─────────────
const vapid = webpush.generateVAPIDKeys();
const goodProd = () => ({
  NODE_ENV: 'production',
  JWT_SECRET: require('crypto').randomBytes(32).toString('hex'),
  DATABASE_URL: 'postgresql://postgres.abcdefghijklmnop:dbpass123456@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
  DIRECT_URL: 'postgresql://postgres.abcdefghijklmnop:dbpass123456@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_ANON_KEY: 'anonkey_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  SUPABASE_SERVICE_ROLE_KEY: 'servicekey_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  CLIENT_URL: 'https://app.localhire-prod.org', SERVER_PUBLIC_URL: 'https://app.localhire-prod.org', ALLOWED_ORIGIN: 'https://app.localhire-prod.org',
  RAZORPAY_KEY_ID: 'rzp_live_AbCdEfGhIj1234', RAZORPAY_KEY_SECRET: 'rzpsecret_cccccccccccccccccc', RAZORPAY_WEBHOOK_SECRET: 'whsecret_dddddddddddddddddd',
  PAYOUT_MODE: 'LEDGER_ONLY', WORKER_COMMISSION_PERCENT: '10', BUSINESS_TIMEZONE: 'Asia/Kolkata',
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:ops@localhire-prod.org',
  TRUST_PROXY: '1'
});
const mutate = (patch, drop = []) => { const e = { ...goodProd(), ...patch }; drop.forEach((k) => delete e[k]); return e; };
const has = (list, needle) => list.some((m) => m.includes(needle));

test('env validation: a complete production environment passes with no errors or warnings', () => {
  const r = validateEnv(goodProd());
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []); assert.equal(r.production, true);
});

test('env validation: every production-critical secret is required, and placeholders / development defaults are refused', () => {
  const must = [
    ['JWT_SECRET', mutate({}, ['JWT_SECRET'])], ['DATABASE_URL', mutate({}, ['DATABASE_URL'])],
    ['SUPABASE_URL', mutate({}, ['SUPABASE_URL'])], ['SUPABASE_ANON_KEY', mutate({}, ['SUPABASE_ANON_KEY'])], ['SUPABASE_SERVICE_ROLE_KEY', mutate({}, ['SUPABASE_SERVICE_ROLE_KEY'])],
    ['CLIENT_URL', mutate({}, ['CLIENT_URL'])], ['SERVER_PUBLIC_URL', mutate({}, ['SERVER_PUBLIC_URL'])],
    ['RAZORPAY_KEY_ID', mutate({}, ['RAZORPAY_KEY_ID'])], ['RAZORPAY_KEY_SECRET', mutate({}, ['RAZORPAY_KEY_SECRET'])], ['RAZORPAY_WEBHOOK_SECRET', mutate({}, ['RAZORPAY_WEBHOOK_SECRET'])]
  ];
  for (const [name, env] of must) { const r = validateEnv(env); assert.ok(has(r.errors, name), `${name} missing must be an error: ${JSON.stringify(r.errors)}`); }

  for (const weak of ['testsecret', 'secret', 'replace_with_a_secure_random_jwt_secret_key', 'short', 'x'.repeat(31)]) assert.ok(has(validateEnv(mutate({ JWT_SECRET: weak })).errors, 'JWT_SECRET'), `weak JWT secret ${weak}`);
  assert.ok(has(validateEnv(mutate({ SUPABASE_SERVICE_ROLE_KEY: 'replace_with_your_supabase_service_role_secret_key' })).errors, 'SUPABASE_SERVICE_ROLE_KEY'));
  assert.ok(has(validateEnv(mutate({ SUPABASE_URL: 'https://your-project-id.supabase.co' })).errors, 'SUPABASE_URL'));
  assert.ok(has(validateEnv(mutate({ RAZORPAY_KEY_SECRET: 'replace_with_your_razorpay_secret_key' })).errors, 'RAZORPAY_KEY_SECRET'));
  assert.ok(has(validateEnv(mutate({ RAZORPAY_WEBHOOK_SECRET: 'replace_with_your_razorpay_webhook_secret' })).errors, 'RAZORPAY_WEBHOOK_SECRET'));
  assert.ok(has(validateEnv(mutate({ DATABASE_URL: 'postgresql://postgres.your-project-id:your_db_password@host:6543/postgres' })).errors, 'DATABASE_URL'));
  assert.ok(has(validateEnv(mutate({ SUPABASE_ANON_KEY: 'same_key_value_1234567890', SUPABASE_SERVICE_ROLE_KEY: 'same_key_value_1234567890' })).errors, 'identical'), 'anon and service-role keys must differ');
  assert.ok(has(validateEnv(mutate({ RAZORPAY_KEY_ID: 'key_live_notrazorpay' })).errors, 'RAZORPAY_KEY_ID'));
});

test('env validation: URLs, CORS, proxy, payout, push and number settings', () => {
  assert.ok(has(validateEnv(mutate({ CLIENT_URL: 'http://app.localhire-prod.org' })).errors, 'CLIENT_URL must use https'));
  assert.ok(has(validateEnv(mutate({ SERVER_PUBLIC_URL: 'https://localhost:5000' })).errors, 'localhost'));
  assert.ok(has(validateEnv(mutate({ SUPABASE_URL: 'http://abcdefghijklmnop.supabase.co' })).errors, 'SUPABASE_URL must be an https'));
  assert.ok(has(validateEnv(mutate({ ALLOWED_ORIGIN: '*' })).errors, 'ALLOWED_ORIGIN'));
  assert.ok(has(validateEnv(mutate({ ALLOWED_ORIGIN: 'http://evil.example' })).errors, 'non-https origin'));
  assert.ok(has(validateEnv(mutate({ NODE_ENV: 'prod' })).errors, 'NODE_ENV'), 'a typo must not silently run as development');
  assert.ok(has(validateEnv(mutate({ PAYOUT_MODE: 'LIVE' })).errors, 'PAYOUT_MODE'));
  assert.ok(has(validateEnv(mutate({ PAYOUT_MODE: 'ROUTE' })).warnings, 'route-check'), 'ROUTE needs a warning, never silent');
  for (const k of ['WORKER_COMMISSION_PERCENT', 'PLATFORM_FEE_PERCENT', 'PLATFORM_FEE_TAX_PERCENT', 'CUSTOMER_CANCELLATION_FEE_PERCENT']) {
    assert.ok(has(validateEnv(mutate({ [k]: '150' })).errors, k), `${k}=150`); assert.ok(has(validateEnv(mutate({ [k]: 'ten' })).errors, k), `${k}=ten`);
  }
  assert.ok(has(validateEnv(mutate({ BUSINESS_TIMEZONE: 'Mars/Phobos' })).errors, 'BUSINESS_TIMEZONE'));
  assert.ok(has(validateEnv(mutate({ PORT: 'abc' })).errors, 'PORT'));
  // Web Push: all three or none; keys must be real P-256 keys
  assert.ok(has(validateEnv(mutate({}, ['VAPID_PRIVATE_KEY'])).errors, 'VAPID'), 'partial VAPID is an error');
  assert.ok(has(validateEnv(mutate({ VAPID_PUBLIC_KEY: 'notakey' })).errors, 'VAPID_PUBLIC_KEY'));
  assert.ok(has(validateEnv(mutate({ VAPID_SUBJECT: 'ops@localhire-prod.org' })).errors, 'VAPID_SUBJECT'));
  const none = validateEnv(mutate({}, ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']));
  assert.deepEqual(none.errors, []); assert.ok(has(none.warnings, 'push notifications are switched off'));
  // Proxy
  assert.ok(has(validateEnv(mutate({}, ['TRUST_PROXY'])).warnings, 'TRUST_PROXY'));
  assert.ok(has(validateEnv(mutate({ TRUST_PROXY: 'true' })).warnings, 'spoof'));
  assert.equal(parseTrustProxy(undefined), false); assert.equal(parseTrustProxy('1'), 1); assert.equal(parseTrustProxy('true'), true);
  assert.deepEqual(parseTrustProxy('10.0.0.1, 10.0.0.2'), ['10.0.0.1', '10.0.0.2']);
  // Test keys in production are allowed (staging) but never silent
  const stage = validateEnv(mutate({ RAZORPAY_KEY_ID: 'rzp_test_AbCdEfGhIj1234' }));
  assert.deepEqual(stage.errors, []); assert.ok(has(stage.warnings, 'TEST key'));
});

test('env validation: outside production the same gaps are warnings, but JWT_SECRET and DATABASE_URL are always required', () => {
  const dev = validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'devsecret', DATABASE_URL: 'postgresql://postgres:pw@localhost:5432/lh' });
  assert.deepEqual(dev.errors, []); assert.ok(dev.warnings.length > 0 && has(dev.warnings, 'RAZORPAY'));
  assert.ok(has(validateEnv({ NODE_ENV: 'development', DATABASE_URL: 'x' }).errors, 'JWT_SECRET'));
  assert.ok(has(validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'x' }).errors, 'DATABASE_URL'));
  assert.ok(has(validateEnv({ NODE_ENV: 'development', JWT_SECRET: 'x', DATABASE_URL: 'x', ALLOWED_ORIGIN: '*' }).errors, 'ALLOWED_ORIGIN'), 'wildcard CORS is wrong everywhere');
});

test('env validation: messages name variables but never print secret values; enforce() exits on errors', () => {
  const env = mutate({ JWT_SECRET: 'testsecret', RAZORPAY_KEY_SECRET: 'replace_with_secret_value_zzz' });
  const lines = []; let code = null;
  const log = { warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  enforce(env, log, (c) => { code = c; });
  assert.equal(code, 1);
  const out = lines.join('\n');
  assert.ok(out.includes('JWT_SECRET') && out.includes('[FATAL]'));
  for (const secret of ['testsecret', 'replace_with_secret_value_zzz', env.SUPABASE_SERVICE_ROLE_KEY, env.RAZORPAY_WEBHOOK_SECRET, env.DATABASE_URL]) assert.ok(!out.includes(secret), 'a secret value was printed');
  let ok = null; enforce(goodProd(), { warn() {}, error() {} }, (c) => { ok = c; }); assert.equal(ok, null, 'a valid environment does not exit');
});

// ── Real server processes ────────────────────────────────────────────────────
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const runServer = (env, { waitMs = 8000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, cwd: path.resolve(__dirname, '..') });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let exited = false; child.on('exit', (code) => { exited = true; resolve({ child, code, out: () => out, exited: () => true }); });
  const started = setInterval(() => { if (/running on port/.test(out)) { clearInterval(started); resolve({ child, code: null, out: () => out, exited: () => exited }); } }, 100);
  setTimeout(() => { clearInterval(started); if (!exited && !/running on port/.test(out)) resolve({ child, code: 'timeout', out: () => out, exited: () => exited }); }, waitMs);
});

test('startup: a production server with missing or placeholder secrets refuses to start and prints no secret values', async () => {
  const bad = { NODE_ENV: 'production', JWT_SECRET: 'testsecret', DATABASE_URL: 'postgresql://postgres:supersecretdbpw@db.example.org:5432/postgres', PORT: String(await freePort()) };
  const r = await runServer(bad);
  assert.equal(r.code, 1, r.out());
  const out = r.out();
  assert.match(out, /\[FATAL\] JWT_SECRET/); assert.match(out, /SUPABASE_SERVICE_ROLE_KEY/); assert.match(out, /RAZORPAY_KEY_ID/); assert.match(out, /Refusing to start in production/);
  assert.ok(!out.includes('supersecretdbpw') && !out.includes('testsecret'), 'secret values must never be logged');
  assert.ok(!/running on port/.test(out), 'it must not have started listening');
});

test('startup: a correctly configured production server starts, forces HTTPS behind a proxy, and hides internals', async () => {
  const port = await freePort();
  const r = await runServer({ ...goodProd(), PORT: String(port) });
  try {
    assert.equal(r.code, null, `did not start: ${r.out()}`);
    const url = `http://127.0.0.1:${port}`;
    // plain HTTP (no X-Forwarded-Proto) is redirected to the configured public HTTPS host; the health check is exempt
    const redirected = await fetch(`${url}/api/categories`, { redirect: 'manual' });
    assert.equal(redirected.status, 308); assert.equal(redirected.headers.get('location'), 'https://app.localhire-prod.org/api/categories');
    assert.equal((await fetch(`${url}/api/health`, { redirect: 'manual' })).status, 200, 'platform health probes work over HTTP');
    // behind the proxy, HTTPS requests are served with HSTS and hardening headers
    const h = { 'X-Forwarded-Proto': 'https' };
    const ok = await fetch(`${url}/api/health`, { headers: h });
    assert.match(ok.headers.get('strict-transport-security'), /max-age=\d+/);
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff'); assert.equal(ok.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(ok.headers.get('x-powered-by'), null); assert.equal(ok.headers.get('cache-control'), 'no-store');
    // development origins are not trusted in production; unknown origins get a JSON refusal, not a stack trace
    const cors = await fetch(`${url}/api/health`, { headers: { ...h, Origin: 'http://localhost:3000' } });
    assert.equal(cors.status, 403); const body = await cors.text(); assert.ok(!body.includes('at ') && !/node_modules|\.js:\d+/.test(body)); assert.equal(JSON.parse(body).success, false);
    const allowed = await fetch(`${url}/api/health`, { headers: { ...h, Origin: 'https://app.localhire-prod.org' } });
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.localhire-prod.org');
    assert.equal((await fetch(`${url}/api/health`, { headers: { ...h, Origin: 'null' } })).status, 403, 'the opaque "null" origin is not trusted in production');
    // malformed JSON: clean 400
    const bad = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{"email": ' });
    assert.equal(bad.status, 400); assert.equal((await bad.json()).message, 'The request body is not valid JSON.');
    assert.ok(!r.out().includes('dbpass123456') && !r.out().includes(goodProd().RAZORPAY_KEY_SECRET.slice(0, 8) + 'zzz'), 'no secrets in startup logs');
    assert.match(r.out(), /Razorpay gateway credentials present \(LIVE mode\)/, 'LIVE mode is announced, never hidden');
    assert.match(r.out(), /PAYOUT_MODE=LEDGER_ONLY/);
  } finally { r.child.kill(); }
});

// ── In-process: error handling and headers ───────────────────────────────────
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  const users = created.slice();
  await prisma.review.deleteMany({ where: { workerId: { in: users } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { OR: [{ customerId: { in: users } }, { workerId: { in: users } }] } }).catch(() => {});
  await prisma.jobPost.deleteMany({ where: { customerId: { in: users } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  require('../services/trackingService').stopSweeper();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

const api = async (method, p, { token, json, headers = {} } = {}) => {
  const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`;
  let body; if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, data, text, headers: res.headers };
};

test('hardening (in-process): headers, JSON errors and internal details never reach clients in production', async () => {
  app.get('/api/__phase9_boom', (req, res) => res.status(500).json({ success: false, message: 'Server error', error: 'relation "User" SELECT secret_column failed at /srv/app/x.js:12', stack: 'Error: boom\n at x' }));
  app.get('/api/__phase9_throw', () => { throw new Error('database password is hunter2'); });
  { // keep the final error handler last, as it is in the real app, so these late-added routes exercise it
    const stack = app._router.stack; const i = stack.findIndex((l) => l.handle && l.handle.length === 4 && !l.route);
    if (i >= 0 && i < stack.length - 1) stack.push(stack.splice(i, 1)[0]);
  }
  const was = process.env.NODE_ENV;
  try {
    // development shows the detail (useful locally)...
    process.env.NODE_ENV = 'development';
    assert.ok((await api('GET', '/api/__phase9_boom')).data.error, 'development keeps debugging detail');
    // ...production never does
    process.env.NODE_ENV = 'production';
    const boom = await api('GET', '/api/__phase9_boom');
    assert.equal(boom.status, 500); assert.equal(boom.data.message, 'Server error'); assert.ok(!('error' in boom.data) && !('stack' in boom.data) && !boom.text.includes('secret_column'));
    const thrown = await api('GET', '/api/__phase9_throw');
    assert.equal(thrown.status, 500); assert.deepEqual(Object.keys(thrown.data).sort(), ['message', 'success']); assert.ok(!thrown.text.includes('hunter2') && !thrown.text.includes('at '));
    // 4xx validation messages are untouched
    const login = await api('POST', '/api/auth/login', { json: {} }); assert.equal(login.status, 400); assert.ok(login.data.message);
    // behind a TLS-terminating proxy, HSTS is sent
    app.set('trust proxy', 1);
    const s = await api('GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(s.headers.get('strict-transport-security') || '', /max-age/);
  } finally { process.env.NODE_ENV = was; app.set('trust proxy', false); }
  const res = await api('GET', '/api/health');
  assert.equal(res.headers.get('x-powered-by'), null); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin'); assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
  assert.ok(!res.headers.get('strict-transport-security'), 'no HSTS outside production');
  assert.equal((await api('POST', '/api/auth/login', { headers: { 'Content-Type': 'application/json' } })).status, 400);
  const malformed = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).success, false);
  const cors = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(cors.status, 403); assert.equal((await cors.json()).message, 'This origin is not allowed.');
});

// ── Authorization boundaries ─────────────────────────────────────────────────
const makeUser = async (label, role) => {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} Person`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210' } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
};

// Walk the real Express route table (nothing is hand-maintained except the deliberate public allowlist).
const unmount = (re) => re.source.replace('^\\/?(?=\\/|$)', '').replace('\\/?(?=\\/|$)', '').replace(/^\^/, '').replace(/\\\//g, '/').replace(/\$$/, '');
const listRoutes = () => {
  const routes = [];
  const walk = (stack, prefix) => stack.forEach((l) => {
    if (l.route) Object.keys(l.route.methods).forEach((m) => routes.push({ method: m.toUpperCase(), path: prefix + l.route.path }));
    else if (l.name === 'router' && l.handle.stack) walk(l.handle.stack, prefix + unmount(l.regexp));
  });
  walk(app._router.stack, '');
  return routes.filter((r) => r.path.startsWith('/api') && !r.path.includes('__phase9'));
};
// Deliberately public: everything else must answer 401 to an anonymous caller.
const PUBLIC = new Set([
  'GET /api/health', 'GET /api/categories/', 'GET /api/marketplace/home', 'GET /api/marketplace/suggest',
  'GET /api/users/workers', 'GET /api/users/workers/:id', 'GET /api/reviews/worker/:workerId', 'GET /api/jobs/', 'GET /api/jobs/:id',
  'GET /api/payments/config', 'GET /api/escrow/razorpay/config', 'GET /api/escrow/status', 'GET /api/push/config',
  'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password',
  'POST /api/auth/resend-verification', 'POST /api/auth/verify-email', 'GET /api/auth/google', 'GET /api/auth/google/callback',
  'POST /api/payments/webhook', 'POST /api/escrow/razorpay/webhook' // authenticated by Razorpay's signature instead (tested in payments.test.js)
]);
const fill = (p) => p.replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000');

test('authorization: every non-public API route rejects anonymous callers (route table is enumerated, not hand-listed)', async () => {
  const routes = listRoutes();
  assert.ok(routes.length > 100, `expected the full route table, found ${routes.length}`);
  const open = []; const unexpectedlyPublic = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    const res = await api(r.method, fill(r.path), { json: ['GET', 'HEAD'].includes(r.method) ? undefined : {} });
    if (PUBLIC.has(key)) continue;
    if (res.status !== 401) unexpectedlyPublic.push(`${key} -> ${res.status}`);
    else open.push(key);
  }
  assert.deepEqual(unexpectedlyPublic, [], 'these routes answered an anonymous caller; add authentication or list them as public on purpose');
  assert.ok(open.length >= 100);
  // the allowlist must not hide stale entries either
  const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
  for (const k of PUBLIC) assert.ok(known.has(k), `allowlist entry no longer exists: ${k}`);
});

test('authorization: customers and professionals are refused on every admin route, and cannot cross into each other\'s areas', async () => {
  const customer = await makeUser('c1', 'CUSTOMER'); const worker = await makeUser('w1', 'WORKER');
  const adminRoutes = listRoutes().filter((r) => r.path.startsWith('/api/admin'));
  assert.ok(adminRoutes.length >= 40, `admin routes found: ${adminRoutes.length}`);
  for (const r of adminRoutes) {
    for (const who of [customer, worker]) {
      const res = await api(r.method, fill(r.path), { token: who.token, json: ['GET', 'HEAD'].includes(r.method) ? undefined : {} });
      assert.equal(res.status, 403, `${r.method} ${r.path} as ${who.user.role} -> ${res.status}`);
    }
  }
  // private identity documents: only the admin-only signed-URL endpoint exists, and it is closed to everyone else
  assert.ok(adminRoutes.some((r) => /documents\/:docId\/url/.test(r.path)));
  const cross = [
    ['worker -> customer review write', 'POST', '/api/reviews', worker], ['customer -> worker review inbox', 'GET', '/api/reviews/received', customer],
    ['customer -> worker dashboard', 'GET', '/api/worker/dashboard', customer], ['customer -> worker documents', 'GET', '/api/worker/documents', customer],
    ['worker -> customer payment history', 'GET', '/api/payments/history', worker], ['worker -> pay for a booking', 'POST', `/api/payments/booking/${fill(':id')}/order`, worker],
    ['worker -> confirm completion', 'POST', `/api/payments/booking/${fill(':id')}/confirm-completion`, worker], ['customer -> worker earnings', 'GET', '/api/worker/earnings', customer]
  ];
  for (const [label, m, p, who] of cross) {
    const res = await api(m, p, { token: who.token, json: m === 'GET' ? undefined : {} });
    assert.ok([403, 404].includes(res.status), `${label} -> ${res.status} ${res.text.slice(0, 80)}`);
    if (label !== 'worker -> pay for a booking' && label !== 'worker -> confirm completion') assert.equal(res.status, 403, `${label} must be refused by role, not by a missing route`);
    assert.notEqual(res.status, 200, label);
  }
  // a revoked / tampered session is refused
  assert.equal((await api('GET', '/api/bookings/my', { token: customer.token + 'x' })).status, 401);
  assert.equal((await api('GET', '/api/bookings/my', { token: 'Bearer nonsense' })).status, 401);
  const jwt = require('jsonwebtoken');
  assert.equal((await api('GET', '/api/bookings/my', { token: jwt.sign({ id: customer.user.id, role: 'Admin' }, 'wrong-secret') })).status, 401, 'a token signed with another secret is refused');
});

// ── Public privacy ───────────────────────────────────────────────────────────
const FORBIDDEN_KEYS = ['email', 'phone', 'latitude', 'longitude', 'lat', 'lng', 'lon', 'coordinates', 'maplocation', 'passwordhash', 'tokenversion', 'supabaseauthid', 'documents', 'documenturl', 'address', 'street', 'postalcode', 'pan', 'ifsc', 'accountnumber'];
const scan = (value, found = [], trail = '') => {
  if (Array.isArray(value)) value.forEach((v, i) => scan(v, found, `${trail}[${i}]`));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => {
    // The only allowed 'address' is the public service-area label (locality, city) inside `location`, never a street address.
    const serviceAreaLabel = k.toLowerCase() === 'address' && trail.endsWith('.location') && typeof v === 'string' && /^[A-Za-z .,'-]+$/.test(v);
    if (FORBIDDEN_KEYS.includes(k.toLowerCase()) && !serviceAreaLabel) found.push(`${trail}.${k}`);
    scan(v, found, `${trail}.${k}`);
  });
  return found;
};

test('privacy: public discovery, profile, review, job and marketplace responses carry no coordinates or private contact details', async () => {
  const cat = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  const customer = await makeUser('pc', 'CUSTOMER'); const worker = await makeUser('pw', 'WORKER');
  const wp = await prisma.workerProfile.create({ data: { userId: worker.user.id, primaryCategoryId: cat.id, hourlyRate: 300, verificationStatus: 'VERIFIED', city: 'Belagavi', locality: 'Tilakwadi', bio: 'Reliable plumber' } });
  await prisma.workerLocation.create({ data: { workerProfileId: wp.id, latitude: 15.8497123, longitude: 74.4977456, lastLocationUpdate: new Date(), isAvailable: true, sharingEnabled: true } });
  const booking = await prisma.booking.create({ data: { bookingNumber: `BK-${tag}-1`, customerId: customer.user.id, workerId: worker.user.id, status: 'COMPLETED', agreedPrice: 500, scheduledAt: new Date(Date.now() - 86400000) } });
  await prisma.review.create({ data: { bookingId: booking.id, customerId: customer.user.id, workerId: worker.user.id, rating: 5, comment: 'Excellent work and very polite.' } });
  await prisma.workerProfile.update({ where: { id: wp.id }, data: { rating: 5, reviewsCount: 1 } });
  const job = await prisma.jobPost.create({ data: { customerId: customer.user.id, categoryId: cat.id, title: `Tap leak ${tag}`, description: 'Kitchen tap leaking', urgency: 'FLEXIBLE', status: 'OPEN' } });
  const flagged = await prisma.jobPost.create({ data: { customerId: customer.user.id, categoryId: cat.id, title: `Flagged ${tag}`, description: 'Abusive text', urgency: 'FLEXIBLE', status: 'OPEN', isFlagged: true, flagReason: 'abuse' } });

  const endpoints = [
    `/api/users/workers?q=${encodeURIComponent(worker.user.name)}&lat=15.85&lng=74.5&radiusKm=20`, `/api/users/workers?sort=rating&reviewedOnly=true`, `/api/users/workers/${worker.user.id}`,
    `/api/reviews/worker/${worker.user.id}`, `/api/marketplace/home?lat=15.85&lng=74.5&radiusKm=20`, `/api/marketplace/suggest?q=plum`, `/api/categories`, `/api/jobs`, `/api/jobs/${job.id}`
  ];
  let sawWorker = false;
  for (const e of endpoints) {
    const res = await api('GET', e);
    assert.equal(res.status, 200, e);
    assert.deepEqual(scan(res.data), [], `${e} exposes private keys`);
    for (const needle of [worker.user.email, customer.user.email, '98765', '15.8497', '74.4977', '15.85', '74.49']) assert.ok(!res.text.includes(needle), `${e} contains ${needle}`);
    if (res.text.includes(worker.user.id)) sawWorker = true;
  }
  assert.ok(sawWorker, 'the worker was visible in public responses, so the checks above were meaningful');
  const list = (await api('GET', `/api/users/workers?q=${encodeURIComponent(worker.user.name)}&lat=15.85&lng=74.5&radiusKm=20`)).data;
  const card = (list.workers || []).find((w) => w.id === worker.user.id);
  assert.ok(card && typeof card.distanceKm === 'number' && (card.distanceKm * 2) % 1 === 0, `distance is rounded to 0.5 km: ${card && card.distanceKm}`);
  assert.equal(card.rating, 5); assert.equal(card.reviewsCount, 1);
  assert.equal(card.location.address, 'Tilakwadi, Belagavi', 'location is only the public service-area label');
  // jobs flagged by an administrator are not public
  const jobs = (await api('GET', '/api/jobs')).data.jobs.map((j) => j.id);
  assert.ok(jobs.includes(job.id)); assert.ok(!jobs.includes(flagged.id), 'flagged job must not be listed');
  assert.equal((await api('GET', `/api/jobs/${flagged.id}`)).status, 404, 'flagged job detail is not public');
  // the public job board must never carry contact data
  const pubJob = (await api('GET', `/api/jobs/${job.id}`)).data.job;
  assert.ok(!('email' in pubJob) && !('phone' in pubJob));
});

// ── Release tooling ──────────────────────────────────────────────────────────
const runScript = (script, args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.resolve(__dirname, '..', 'scripts', script), ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATABASE_URL: process.env.DATABASE_URL, JWT_SECRET: process.env.JWT_SECRET, ...env } });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('exit', (code) => resolve({ code, out }));
});

test('release tooling: the demo seed refuses to run in production; the admin promotion script is dry-run by default and refuses unsafe targets', async () => {
  const seed = await runScript('../prisma/seed.js', [], { NODE_ENV: 'production' });
  assert.equal(seed.code, 1); assert.match(seed.out, /REFUSING TO RUN/); assert.ok(!/Seeding categories|Seed\] Starting/.test(seed.out), 'it must not start seeding');
  assert.equal(await prisma.user.count({ where: { email: 'admin@localhire.dev' } }), 0, 'no admin account was created');

  const person = await makeUser('promo', 'CUSTOMER');
  const dry = await runScript('promote-admin.js', [person.user.email]);
  assert.equal(dry.code, 0, dry.out); assert.match(dry.out, /Dry run only/);
  assert.equal((await prisma.user.findUnique({ where: { id: person.user.id } })).role, 'CUSTOMER', 'a dry run changes nothing');
  assert.ok(!dry.out.includes('postgresql://') && !dry.out.includes('localtest'), 'no connection string or password in output');

  assert.equal((await runScript('promote-admin.js', ['nobody@example.invalid', '--apply'])).code, 1, 'unknown account refused');
  const unverified = await prisma.user.create({ data: { email: `${tag}.unv@example.com`, name: 'Unverified', role: 'CUSTOMER', isEmailVerified: false, passwordHash: null } }); created.push(unverified.id);
  assert.equal((await runScript('promote-admin.js', [unverified.email, '--apply'])).code, 1, 'unverified account refused');
  const suspended = await prisma.user.create({ data: { email: `${tag}.sus@example.com`, name: 'Suspended', role: 'CUSTOMER', isEmailVerified: true, isActive: false, passwordHash: null } }); created.push(suspended.id);
  assert.equal((await runScript('promote-admin.js', [suspended.email, '--apply'])).code, 1, 'deactivated account refused');
  assert.equal((await runScript('promote-admin.js', [])).code, 2, 'usage error');

  const before = (await prisma.user.findUnique({ where: { id: person.user.id } })).tokenVersion;
  const done = await runScript('promote-admin.js', [person.user.email, '--apply']);
  assert.equal(done.code, 0, done.out);
  const after = await prisma.user.findUnique({ where: { id: person.user.id } });
  assert.equal(after.role, 'ADMIN'); assert.equal(after.tokenVersion, before + 1, 'existing sessions are invalidated');
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'ADMIN_PROMOTED_VIA_CLI', entityId: person.user.id } }));
  await prisma.auditLog.deleteMany({ where: { entityId: person.user.id } });
  assert.match((await runScript('promote-admin.js', [person.user.email, '--apply'])).out, /already an Administrator/);
});

