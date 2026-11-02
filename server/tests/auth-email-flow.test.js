// Auth flows: registration + email verification, login gating, logout revocation,
// forgot/reset password and Google OAuth. Prisma and the Supabase Auth client are replaced with
// in-memory fakes, so these verify LocalHire's logic, NOT the live Supabase/Google integration.
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.CLIENT_URL = 'http://localhost:5000';
process.env.SERVER_PUBLIC_URL = 'http://localhost:5000';

const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const authController = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const { signSessionToken } = require('../services/authTokens');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    redirectedTo: null,
    cookies: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
    cookie(name, value) { this.cookies[name] = value; return this; },
    clearCookie(name) { delete this.cookies[name]; return this; }
  };
}

// In-memory stand-in for prisma.user
function installFakePrisma(initial = []) {
  const rows = initial.map((u) => ({ tokenVersion: 0, isActive: true, passwordHash: null, supabaseAuthId: null, ...u }));
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const original = {
    findUnique: prisma.user.findUnique,
    create: prisma.user.create,
    update: prisma.user.update
  };
  prisma.user.findUnique = async ({ where }) => rows.find((r) => matches(r, where)) || null;
  prisma.user.create = async ({ data }) => {
    const row = { id: `u${rows.length + 1}`, tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(), ...data };
    rows.push(row);
    return row;
  };
  prisma.user.update = async ({ where, data }) => {
    const row = rows.find((r) => matches(r, where));
    if (!row) throw new Error('not found');
    for (const [k, v] of Object.entries(data)) {
      row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
    }
    return row;
  };
  return { rows, restore: () => Object.assign(prisma.user, original) };
}

function installFakeSupabase(overrides = {}) {
  const calls = { signUp: [], resend: [], reset: [], signIn: [], createUser: [], deleteUser: [], updateUser: [], getUser: [] };
  const original = {
    isAuthConfigured: supabaseConfig.isAuthConfigured,
    createAuthClient: supabaseConfig.createAuthClient,
    supabaseAdmin: supabaseConfig.supabaseAdmin
  };
  supabaseConfig.isAuthConfigured = () => overrides.configured !== false;
  supabaseConfig.createAuthClient = () => ({
    auth: {
      signUp: async (args) => {
        calls.signUp.push(args);
        return overrides.signUp
          ? overrides.signUp(args)
          : { data: { user: { id: 'sb-new', email: args.email, email_confirmed_at: null, identities: [{ provider: 'email' }] }, session: null }, error: null };
      },
      resend: async (args) => { calls.resend.push(args); return { data: {}, error: overrides.resendError || null }; },
      resetPasswordForEmail: async (email, opts) => { calls.reset.push({ email, opts }); return { data: {}, error: null }; },
      signInWithPassword: async (args) => {
        calls.signIn.push(args);
        return overrides.signIn ? overrides.signIn(args) : { data: null, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } };
      }
    }
  });
  supabaseConfig.supabaseAdmin = {
    auth: {
      getUser: async (token) => {
        calls.getUser.push(token);
        return overrides.getUser ? overrides.getUser(token) : { data: { user: null }, error: { message: 'invalid' } };
      },
      admin: {
        createUser: async (attrs) => { calls.createUser.push(attrs); return { data: { user: { id: 'sb-linked' } }, error: null }; },
        deleteUser: async (id) => { calls.deleteUser.push(id); return { error: null }; },
        updateUserById: async (id, attrs) => { calls.updateUser.push({ id, attrs }); return { data: {}, error: null }; }
      }
    }
  };
  return { calls, restore: () => Object.assign(supabaseConfig, original) };
}

const TOKEN = 'x'.repeat(40); // shape-valid access token for the fake provider

// ── Registration ─────────────────────────────────────────────────────────────

test('register accepts a real email, sends verification via the provider and issues NO session', async () => {
  const db = installFakePrisma();
  const sb = installFakeSupabase();
  try {
    const res = createRes();
    await authController.register({ body: { name: 'Priya Rao', email: 'Priya.Rao@Gmail.com ', password: 'Str0ngPass!', role: 'worker' } }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.requiresEmailVerification, true);
    assert.equal(res.payload.token, undefined, 'no token before verification');
    assert.equal(res.payload.user, undefined);

    assert.equal(sb.calls.signUp.length, 1);
    assert.equal(sb.calls.signUp[0].email, 'priya.rao@gmail.com');
    assert.equal(sb.calls.signUp[0].options.emailRedirectTo, 'http://localhost:5000/pages/auth.html');

    const row = db.rows[0];
    assert.equal(row.isEmailVerified, false, 'not verified until the link is used');
    assert.equal(row.role, 'WORKER');
    assert.equal(row.supabaseAuthId, 'sb-new');
    assert.equal(row.passwordHash, null, 'password is held only by the provider');
  } finally { db.restore(); sb.restore(); }
});

test('register rejects malformed email and weak password before calling the provider', async () => {
  const db = installFakePrisma();
  const sb = installFakeSupabase();
  try {
    for (const email of ['not-an-email', 'a@b', 'a b@c.com', 'a@@c.com', '.a@c.com', 'a..b@c.com']) {
      const res = createRes();
      await authController.register({ body: { name: 'X', email, password: 'Str0ngPass!' } }, res);
      assert.equal(res.statusCode, 400, `email ${email}`);
    }
    const res = createRes();
    await authController.register({ body: { name: 'X', email: 'x@example.com', password: 'short' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(sb.calls.signUp.length, 0);
  } finally { db.restore(); sb.restore(); }
});

test('register fails loudly when the provider has email confirmation disabled (no fake verification)', async () => {
  const db = installFakePrisma();
  const sb = installFakeSupabase({
    signUp: async () => ({
      data: { user: { id: 'sb-x', email_confirmed_at: '2026-01-01T00:00:00Z', identities: [{}] }, session: { access_token: 'a' } },
      error: null
    })
  });
  try {
    const res = createRes();
    await authController.register({ body: { name: 'A', email: 'a@example.com', password: 'Str0ngPass!' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, 'EMAIL_CONFIRMATION_DISABLED');
    assert.equal(db.rows.length, 0, 'no local user created');
    assert.deepEqual(sb.calls.deleteUser, ['sb-x'], 'provider identity removed');
  } finally { db.restore(); sb.restore(); }
});

test('register returns 503 (never auto-verifies) when the provider is not configured', async () => {
  const db = installFakePrisma();
  const sb = installFakeSupabase({ configured: false });
  try {
    const res = createRes();
    await authController.register({ body: { name: 'A', email: 'a@example.com', password: 'Str0ngPass!' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.code, 'AUTH_PROVIDER_NOT_CONFIGURED');
    assert.equal(db.rows.length, 0);
  } finally { db.restore(); sb.restore(); }
});

test('register for an already verified email is rejected; unverified one only re-sends the link', async () => {
  const db = installFakePrisma([
    { id: 'v1', email: 'verified@example.com', isEmailVerified: true, supabaseAuthId: 'sb-v' },
    { id: 'p1', email: 'pending@example.com', isEmailVerified: false, supabaseAuthId: 'sb-p' }
  ]);
  const sb = installFakeSupabase();
  try {
    let res = createRes();
    await authController.register({ body: { name: 'A', email: 'verified@example.com', password: 'Str0ngPass!' } }, res);
    assert.equal(res.statusCode, 400);

    res = createRes();
    await authController.register({ body: { name: 'A', email: 'pending@example.com', password: 'Other1234!' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(sb.calls.signUp.length, 0, 'no second sign-up, password not replaced');
    assert.equal(sb.calls.resend.length, 1);
    assert.equal(sb.calls.resend[0].email, 'pending@example.com');
  } finally { db.restore(); sb.restore(); }
});

// ── Email verification ───────────────────────────────────────────────────────

test('verify-email marks the account verified only for a provider-confirmed token, then signs in', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', role: 'WORKER', isEmailVerified: false, supabaseAuthId: 'sb-1', name: 'A' }]);
  const sb = installFakeSupabase({ getUser: async () => ({ data: { user: { id: 'sb-1', email: 'a@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }) });
  try {
    const res = createRes();
    await authController.verifyEmail({ body: { accessToken: TOKEN } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(db.rows[0].isEmailVerified, true);
    assert.equal(res.payload.user.role, 'Worker', 'existing role preserved');
    assert.equal(typeof res.payload.token, 'string');
  } finally { db.restore(); sb.restore(); }
});

test('verify-email rejects an unconfirmed or invalid provider token', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', isEmailVerified: false, supabaseAuthId: 'sb-1' }]);
  let sb = installFakeSupabase({ getUser: async () => ({ data: { user: { id: 'sb-1', email: 'a@example.com', email_confirmed_at: null } }, error: null }) });
  try {
    let res = createRes();
    await authController.verifyEmail({ body: { accessToken: TOKEN } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.rows[0].isEmailVerified, false);
    sb.restore();

    sb = installFakeSupabase(); // getUser -> error
    res = createRes();
    await authController.verifyEmail({ body: { accessToken: TOKEN } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.rows[0].isEmailVerified, false);

    res = createRes();
    await authController.verifyEmail({ body: { accessToken: 'short' } }, res);
    assert.equal(res.statusCode, 400);
  } finally { db.restore(); sb.restore(); }
});

// ── Login ────────────────────────────────────────────────────────────────────

test('login via the provider is blocked until the email is confirmed', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', role: 'CUSTOMER', isEmailVerified: false, supabaseAuthId: 'sb-1' }]);
  const sb = installFakeSupabase({ signIn: async () => ({ data: null, error: { code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' } }) });
  try {
    const res = createRes();
    await authController.login({ body: { email: 'a@example.com', password: 'Str0ngPass!' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(res.payload.token, undefined);
  } finally { db.restore(); sb.restore(); }
});

test('login via the provider succeeds for a confirmed email and keeps the stored role', async () => {
  for (const role of ['CUSTOMER', 'WORKER', 'ADMIN']) {
    const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', role, isEmailVerified: false, supabaseAuthId: 'sb-1', name: 'A' }]);
    const sb = installFakeSupabase({ signIn: async () => ({ data: { user: { id: 'sb-1', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }) });
    try {
      const res = createRes();
      await authController.login({ body: { email: 'A@Example.com', password: 'Str0ngPass!' } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.user.role, { CUSTOMER: 'Customer', WORKER: 'Worker', ADMIN: 'Admin' }[role]);
      assert.equal(db.rows[0].isEmailVerified, true, 'synced from provider-confirmed state');
      assert.equal(jwt.verify(res.payload.token, process.env.JWT_SECRET).id, 'u1');
    } finally { db.restore(); sb.restore(); }
  }
});

test('login with a wrong password or unknown email returns the same 401', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', isEmailVerified: true, supabaseAuthId: 'sb-1' }]);
  const sb = installFakeSupabase(); // signIn -> invalid_credentials
  try {
    let res = createRes();
    await authController.login({ body: { email: 'a@example.com', password: 'wrong-password' } }, res);
    assert.equal(res.statusCode, 401);
    const wrongPasswordMessage = res.payload.message;

    res = createRes();
    await authController.login({ body: { email: 'nobody@example.com', password: 'wrong-password' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.message, wrongPasswordMessage);
  } finally { db.restore(); sb.restore(); }
});

test('login rejects a provider identity that does not match the linked account', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', isEmailVerified: true, supabaseAuthId: 'sb-1' }]);
  const sb = installFakeSupabase({ signIn: async () => ({ data: { user: { id: 'sb-OTHER', email_confirmed_at: 'x' } }, error: null }) });
  try {
    const res = createRes();
    await authController.login({ body: { email: 'a@example.com', password: 'Str0ngPass!' } }, res);
    assert.equal(res.statusCode, 401);
  } finally { db.restore(); sb.restore(); }
});

test('legacy bcrypt account: verified admin can log in without the provider; unverified legacy user cannot', async () => {
  const hash = await bcrypt.hash('LegacyPass1!', 4);
  const db = installFakePrisma([
    { id: 'admin1', email: 'admin@company.com', role: 'ADMIN', isEmailVerified: true, passwordHash: hash },
    { id: 'old1', email: 'old@example.com', role: 'CUSTOMER', isEmailVerified: false, passwordHash: hash }
  ]);
  const sb = installFakeSupabase({ configured: false });
  try {
    let res = createRes();
    await authController.login({ body: { email: 'admin@company.com', password: 'LegacyPass1!' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.user.role, 'Admin');

    res = createRes();
    await authController.login({ body: { email: 'old@example.com', password: 'LegacyPass1!' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'EMAIL_NOT_VERIFIED');

    res = createRes();
    await authController.login({ body: { email: 'old@example.com', password: 'nope' } }, res);
    assert.equal(res.statusCode, 401, 'password is checked before revealing verification state');
  } finally { db.restore(); sb.restore(); }
});

test('resend-verification links a legacy account to the provider (keeping its password) then sends the email', async () => {
  const hash = await bcrypt.hash('LegacyPass1!', 4);
  const db = installFakePrisma([{ id: 'old1', email: 'old@example.com', name: 'Old', role: 'WORKER', isEmailVerified: false, passwordHash: hash }]);
  const sb = installFakeSupabase();
  try {
    const res = createRes();
    await authController.resendVerification({ body: { email: 'old@example.com' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(sb.calls.createUser.length, 1);
    assert.equal(sb.calls.createUser[0].email_confirm, false, 'not confirmed by us');
    assert.equal(sb.calls.createUser[0].password_hash, hash);
    assert.equal(db.rows[0].supabaseAuthId, 'sb-linked');
    assert.equal(sb.calls.resend.length, 1);

    // Unknown address: same response, nothing sent
    const before = sb.calls.resend.length;
    const res2 = createRes();
    await authController.resendVerification({ body: { email: 'ghost@example.com' } }, res2);
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.payload.message, res.payload.message);
    assert.equal(sb.calls.resend.length, before);
  } finally { db.restore(); sb.restore(); }
});

// ── Logout / token revocation ────────────────────────────────────────────────

test('logout revokes previously issued tokens; protect() then rejects them', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', role: 'CUSTOMER', isEmailVerified: true, name: 'A' }]);
  try {
    const token = signSessionToken(db.rows[0]);
    const authz = { headers: { authorization: `Bearer ${token}` } };

    let nextCalled = false;
    await protect({ ...authz }, createRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'token valid before logout');

    const res = createRes();
    await authController.logout({ ...authz }, res);
    assert.equal(res.payload.success, true);
    assert.equal(db.rows[0].tokenVersion, 1);

    nextCalled = false;
    const res2 = createRes();
    await protect({ ...authz }, res2, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res2.statusCode, 401);

    // A fresh login token works again
    nextCalled = false;
    await protect({ headers: { authorization: `Bearer ${signSessionToken(db.rows[0])}` } }, createRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally { db.restore(); }
});

test('logout with a missing/garbage token still succeeds and revokes nothing', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', isEmailVerified: true }]);
  try {
    let res = createRes();
    await authController.logout({ headers: {} }, res);
    assert.equal(res.payload.success, true);
    res = createRes();
    await authController.logout({ headers: { authorization: 'Bearer garbage' } }, res);
    assert.equal(res.payload.success, true);
    assert.equal(db.rows[0].tokenVersion, 0);
  } finally { db.restore(); }
});

test('protect() blocks tokens of unverified or deactivated accounts', async () => {
  const db = installFakePrisma([
    { id: 'u1', email: 'a@example.com', role: 'CUSTOMER', isEmailVerified: false },
    { id: 'u2', email: 'b@example.com', role: 'CUSTOMER', isEmailVerified: true, isActive: false }
  ]);
  try {
    for (const row of db.rows) {
      let nextCalled = false;
      const res = createRes();
      await protect({ headers: { authorization: `Bearer ${signSessionToken(row)}` } }, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
    }
  } finally { db.restore(); }
});

// ── Forgot / reset password ──────────────────────────────────────────────────

test('forgot-password answers identically for known and unknown emails and emails only known ones', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', isEmailVerified: true, supabaseAuthId: 'sb-1' }]);
  const sb = installFakeSupabase();
  try {
    const known = createRes();
    await authController.forgotPassword({ body: { email: 'a@example.com' } }, known);
    const unknown = createRes();
    await authController.forgotPassword({ body: { email: 'ghost@example.com' } }, unknown);

    assert.equal(known.statusCode, 200);
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual(known.payload, unknown.payload);
    assert.equal(sb.calls.reset.length, 1);
    assert.equal(sb.calls.reset[0].email, 'a@example.com');
    assert.equal(sb.calls.reset[0].opts.redirectTo, 'http://localhost:5000/pages/auth.html');

    const bad = createRes();
    await authController.forgotPassword({ body: { email: 'nope' } }, bad);
    assert.equal(bad.statusCode, 400);
  } finally { db.restore(); sb.restore(); }
});

test('reset-password updates the provider password, drops the legacy hash and revokes old sessions', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', isEmailVerified: false, supabaseAuthId: 'sb-1', passwordHash: 'legacy-hash' }]);
  const sb = installFakeSupabase({ getUser: async () => ({ data: { user: { id: 'sb-1', email_confirmed_at: '2026-01-01T00:00:00Z' } }, error: null }) });
  try {
    const res = createRes();
    await authController.resetPassword({ body: { accessToken: TOKEN, password: 'BrandNew#Pass1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sb.calls.updateUser, [{ id: 'sb-1', attrs: { password: 'BrandNew#Pass1' } }]);
    assert.equal(db.rows[0].passwordHash, null);
    assert.equal(db.rows[0].tokenVersion, 1);
    assert.equal(db.rows[0].isEmailVerified, true, 'recovery link proves email ownership');
    assert.equal(res.payload.token, undefined, 'reset does not log in');
  } finally { db.restore(); sb.restore(); }
});

test('reset-password rejects weak passwords and invalid tokens without touching the provider password', async () => {
  const db = installFakePrisma([{ id: 'u1', email: 'a@example.com', supabaseAuthId: 'sb-1' }]);
  const sb = installFakeSupabase();
  try {
    let res = createRes();
    await authController.resetPassword({ body: { accessToken: TOKEN, password: 'short' } }, res);
    assert.equal(res.statusCode, 400);
    res = createRes();
    await authController.resetPassword({ body: { accessToken: TOKEN, password: 'LongEnough#1' } }, res); // getUser -> error
    assert.equal(res.statusCode, 400);
    assert.equal(sb.calls.updateUser.length, 0);
  } finally { db.restore(); sb.restore(); }
});

// ── Google OAuth ─────────────────────────────────────────────────────────────

function googleSession(overrides = {}) {
  return {
    id: 'sb-g1',
    email: 'Gina@Gmail.com',
    email_confirmed_at: '2026-01-01T00:00:00Z',
    identities: [{ provider: 'google', identity_data: { email_verified: true } }],
    user_metadata: { full_name: 'Gina G', avatar_url: 'https://lh3.googleusercontent.com/a' },
    ...overrides
  };
}

function installFakeOAuth({ sessionUser, exchangeError = null }) {
  const original = supabaseConfig.createAuthClient;
  const seen = { exchangedCode: null, storageSeed: null };
  supabaseConfig.createAuthClient = (opts = {}) => ({
    auth: {
      signInWithOAuth: async ({ provider, options }) => {
        opts.storage.setItem('sb-test-code-verifier', 'verifier-123');
        return { data: { provider, url: `https://proj.supabase.co/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(options.redirectTo)}` }, error: null };
      },
      exchangeCodeForSession: async (code) => {
        seen.exchangedCode = code;
        seen.storageSeed = opts.storage.getItem('sb-test-code-verifier');
        return exchangeError
          ? { data: null, error: exchangeError }
          : { data: { session: { user: sessionUser } }, error: null };
      }
    }
  });
  return { seen, restore: () => { supabaseConfig.createAuthClient = original; } };
}

async function runGoogle(role, sessionUser, dbRows = []) {
  const db = installFakePrisma(dbRows);
  const sb = installFakeSupabase();
  const oauth = installFakeOAuth({ sessionUser });
  try {
    const startRes = createRes();
    await authController.googleStart({ query: role ? { role } : {} }, startRes);
    const cookie = startRes.cookies.lh_oauth;
    const cbRes = createRes();
    await authController.googleCallback({ query: { code: 'auth-code-1' }, headers: { cookie: `lh_oauth=${encodeURIComponent(cookie)}` } }, cbRes);
    return { db, sb, oauth, startRes, cbRes };
  } finally { oauth.restore(); sb.restore(); db.restore(); }
}

test('google start redirects to the provider and stores the PKCE verifier in a signed cookie', async () => {
  const sb = installFakeSupabase();
  const oauth = installFakeOAuth({ sessionUser: googleSession() });
  try {
    const res = createRes();
    await authController.googleStart({ query: { role: 'Worker' } }, res);
    assert.match(res.redirectedTo, /^https:\/\/proj\.supabase\.co\/auth\/v1\/authorize\?provider=google/);
    assert.ok(res.redirectedTo.includes(encodeURIComponent('http://localhost:5000/api/auth/google/callback')));
    const state = jwt.verify(res.cookies.lh_oauth, process.env.JWT_SECRET);
    assert.equal(state.role, 'WORKER');
    assert.equal(state.store['sb-test-code-verifier'], 'verifier-123');

    const bad = createRes();
    await authController.googleStart({ query: { role: 'Admin' } }, bad);
    assert.match(bad.redirectedTo, /lh_error=invalid_role/);
  } finally { oauth.restore(); sb.restore(); }
});

test('google callback creates a verified account with the chosen role and hands back an app token', async () => {
  const { db, oauth, cbRes } = await runGoogle('Worker', googleSession());
  assert.equal(oauth.seen.exchangedCode, 'auth-code-1');
  assert.equal(oauth.seen.storageSeed, 'verifier-123', 'verifier restored from the signed cookie');
  assert.match(cbRes.redirectedTo, /^http:\/\/localhost:5000\/pages\/auth\.html#lh_token=.+&lh_new=1$/);
  const row = db.rows[0];
  assert.equal(row.email, 'gina@gmail.com');
  assert.equal(row.role, 'WORKER');
  assert.equal(row.isEmailVerified, true);
  assert.equal(row.supabaseAuthId, 'sb-g1');
  assert.equal(row.passwordHash, null);
  const token = decodeURIComponent(cbRes.redirectedTo.match(/lh_token=([^&]+)/)[1]);
  assert.equal(jwt.verify(token, process.env.JWT_SECRET).id, row.id);
});

test('google callback signs in an existing account, keeping its role, and links + verifies it', async () => {
  const { db, cbRes } = await runGoogle('Customer', googleSession(), [
    { id: 'u9', email: 'gina@gmail.com', name: 'Gina', role: 'ADMIN', isEmailVerified: false, passwordHash: 'h' }
  ]);
  assert.equal(db.rows.length, 1, 'no duplicate user');
  assert.equal(db.rows[0].role, 'ADMIN', 'role not overwritten by the sign-up tab selection');
  assert.equal(db.rows[0].supabaseAuthId, 'sb-g1');
  assert.equal(db.rows[0].isEmailVerified, true);
  assert.match(cbRes.redirectedTo, /#lh_token=[^&]+$/);
  assert.ok(!cbRes.redirectedTo.includes('lh_new'));
});

test('google callback refuses unknown users with no chosen role, unverified Google emails and identity conflicts', async () => {
  let r = await runGoogle('', googleSession());
  assert.match(r.cbRes.redirectedTo, /lh_error=no_account/);
  assert.equal(r.db.rows.length, 0);

  r = await runGoogle('Customer', googleSession({ identities: [{ provider: 'google', identity_data: { email_verified: false } }] }));
  assert.match(r.cbRes.redirectedTo, /lh_error=email_unverified/);
  assert.equal(r.db.rows.length, 0);

  r = await runGoogle('Customer', googleSession(), [
    { id: 'u9', email: 'gina@gmail.com', isEmailVerified: true, supabaseAuthId: 'sb-different' }
  ]);
  assert.match(r.cbRes.redirectedTo, /lh_error=account_conflict/);
  assert.equal(r.db.rows[0].supabaseAuthId, 'sb-different');

  r = await runGoogle('Customer', googleSession(), [
    { id: 'u9', email: 'gina@gmail.com', isEmailVerified: true, isActive: false }
  ]);
  assert.match(r.cbRes.redirectedTo, /lh_error=account_disabled/);
});

test('google callback rejects missing, tampered or forged state cookies and provider errors', async () => {
  const db = installFakePrisma();
  const sb = installFakeSupabase();
  const oauth = installFakeOAuth({ sessionUser: googleSession() });
  try {
    let res = createRes();
    await authController.googleCallback({ query: { code: 'c' }, headers: {} }, res);
    assert.match(res.redirectedTo, /lh_error=session_expired/);

    const forged = jwt.sign({ purpose: 'oauth', store: {}, role: 'CUSTOMER' }, 'attacker-secret');
    res = createRes();
    await authController.googleCallback({ query: { code: 'c' }, headers: { cookie: `lh_oauth=${forged}` } }, res);
    assert.match(res.redirectedTo, /lh_error=session_expired/);

    const good = jwt.sign({ purpose: 'oauth', store: {}, role: 'CUSTOMER' }, process.env.JWT_SECRET);
    res = createRes();
    await authController.googleCallback({ query: { error: 'access_denied' }, headers: { cookie: `lh_oauth=${good}` } }, res);
    assert.match(res.redirectedTo, /lh_error=cancelled/);
    assert.equal(oauth.seen.exchangedCode, null);

    const wrongPurpose = jwt.sign({ id: 'u1' }, process.env.JWT_SECRET); // an app session token must not work as OAuth state
    res = createRes();
    await authController.googleCallback({ query: { code: 'c' }, headers: { cookie: `lh_oauth=${wrongPurpose}` } }, res);
    assert.match(res.redirectedTo, /lh_error=session_expired/);
  } finally { oauth.restore(); sb.restore(); db.restore(); }
});

test('google start reports not_configured instead of pretending to work', async () => {
  const sb = installFakeSupabase({ configured: false });
  try {
    const res = createRes();
    await authController.googleStart({ query: {} }, res);
    assert.match(res.redirectedTo, /lh_error=not_configured/);
  } finally { sb.restore(); }
});

// ── Review fixes: legacy credentials + account linking ───────────────────────

test('linked account whose provider has no password falls back to the local legacy hash (verified only)', async () => {
  const hash = await bcrypt.hash('LegacyPass1!', 4);
  const db = installFakePrisma([
    { id: 'a1', email: 'ok@example.com', role: 'CUSTOMER', isEmailVerified: true, supabaseAuthId: 'sb-1', passwordHash: hash },
    { id: 'a2', email: 'unv@example.com', role: 'CUSTOMER', isEmailVerified: false, supabaseAuthId: 'sb-2', passwordHash: hash }
  ]);
  const sb = installFakeSupabase(); // provider -> invalid_credentials
  try {
    let res = createRes();
    await authController.login({ body: { email: 'ok@example.com', password: 'LegacyPass1!' } }, res);
    assert.equal(res.statusCode, 200);

    res = createRes();
    await authController.login({ body: { email: 'ok@example.com', password: 'nope-nope-1' } }, res);
    assert.equal(res.statusCode, 401);

    res = createRes();
    await authController.login({ body: { email: 'unv@example.com', password: 'LegacyPass1!' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, 'EMAIL_NOT_VERIFIED');
  } finally { db.restore(); sb.restore(); }
});

test('google linking rotates untrusted credentials but leaves trusted ones alone', async () => {
  const cases = [
    // [row, expectHashCleared, expectedTokenVersion]
    [{ id: 'u1', email: 'gina@gmail.com', role: 'CUSTOMER', isEmailVerified: false, supabaseAuthId: 'sb-g1', passwordHash: 'h' }, true, 1],      // pre-registered, never verified
    [{ id: 'u1', email: 'gina@gmail.com', role: 'WORKER', isEmailVerified: true, supabaseAuthId: null, passwordHash: 'h' }, true, 1],          // legacy, flag never earned
    [{ id: 'u1', email: 'gina@gmail.com', role: 'ADMIN', isEmailVerified: true, supabaseAuthId: null, passwordHash: 'h' }, false, 0],          // operator-provisioned admin
    [{ id: 'u1', email: 'gina@gmail.com', role: 'CUSTOMER', isEmailVerified: true, supabaseAuthId: 'sb-g1', passwordHash: 'h' }, false, 0]    // already verified + linked
  ];
  for (const [row, hashCleared, tv] of cases) {
    const { db } = await runGoogle('Customer', googleSession(), [row]);
    assert.equal(db.rows[0].passwordHash === null, hashCleared, JSON.stringify(row));
    assert.equal(db.rows[0].tokenVersion, tv, JSON.stringify(row));
    assert.equal(db.rows[0].isEmailVerified, true);
    assert.equal(db.rows[0].supabaseAuthId, 'sb-g1');
  }
});
