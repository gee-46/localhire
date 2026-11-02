// LocalHire - authentication setup verifier.
//
//   node scripts/verify-auth-setup.js                    read-only checks (env, database schema, live Supabase settings)
//   node scripts/verify-auth-setup.js --probe-password-hash
//        also creates ONE throwaway unconfirmed Supabase user (no email is sent), checks that the provider
//        accepts an imported bcrypt hash, then deletes it.
//
// Optional (dashboard settings that the public API cannot reveal): set SUPABASE_ACCESS_TOKEN in your shell
// (a Supabase personal access token; do NOT put it in .env) and SUPABASE_PROJECT_REF, and the script will
// read - never write - the project's auth config (Site URL, redirect allow-list, SMTP, Confirm email).
//
// Secrets are never printed. Exit code is non-zero if any check FAILS.

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const probe = process.argv.includes('--probe-password-hash');
const env = process.env;
const results = [];
const record = (status, name, detail = '') => {
  results.push(status);
  const tag = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' }[status];
  console.log(`${tag}  ${name}${detail ? '  - ' + detail : ''}`);
};

const isPlaceholder = (v) => !v || /replace_with|your[-_]|example\.com|changeme/i.test(v);
const strip = (u) => String(u || '').replace(/\/+$/, '');

async function checkEnv() {
  console.log('\n== 1. Environment (names only, values never shown) ==');
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'DATABASE_URL', 'CLIENT_URL', 'SERVER_PUBLIC_URL']) {
    if (!env[key] || isPlaceholder(env[key])) record(key === 'CLIENT_URL' || key === 'SERVER_PUBLIC_URL' ? 'WARN' : 'FAIL', `${key} is set`, env[key] ? 'still a placeholder' : 'missing');
    else record('PASS', `${key} is set`);
  }
  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) record('FAIL', 'JWT_SECRET is at least 32 characters');
  if (env.SUPABASE_URL && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(env.SUPABASE_URL) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(env.SUPABASE_URL)) {
    record('WARN', 'SUPABASE_URL looks like https://<project-ref>.supabase.co', 'custom domain or typo?');
  }
  if (env.SUPABASE_ANON_KEY && env.SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY) {
    record('FAIL', 'ANON and SERVICE_ROLE keys are different keys');
  }
  const prod = env.NODE_ENV === 'production';
  for (const key of ['CLIENT_URL', 'SERVER_PUBLIC_URL']) {
    if (env[key] && prod && !/^https:\/\//.test(env[key])) record('FAIL', `${key} uses https in production`, 'OAuth cookies are Secure in production');
  }
  if (env.CLIENT_URL && env.SERVER_PUBLIC_URL) {
    const same = new URL(env.CLIENT_URL).origin === new URL(env.SERVER_PUBLIC_URL).origin;
    record(same ? 'PASS' : 'WARN', 'CLIENT_URL and SERVER_PUBLIC_URL share an origin', same ? '' : 'Express serves the frontend itself; different origins need extra CORS/cookie care');
  }
  if (env.SUPABASE_URL) {
    const base = strip(env.CLIENT_URL || '');
    console.log(`\n   Add these two entries under Supabase -> Authentication -> URL Configuration -> Redirect URLs:`);
    console.log(`     ${base}/pages/auth.html`);
    console.log(`     ${strip(env.SERVER_PUBLIC_URL || '')}/api/auth/google/callback`);
    console.log(`   Set Site URL to: ${base}`);
    console.log(`   Google Cloud authorized redirect URI: ${strip(env.SUPABASE_URL)}/auth/v1/callback`);
  }
}

async function checkDatabase() {
  console.log('\n== 2. Database (PostgreSQL via Prisma, read-only) ==');
  if (!env.DATABASE_URL) return record('SKIP', 'database checks', 'DATABASE_URL missing');
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ log: ['error'] });
  try {
    const cols = await prisma.$queryRawUnsafe(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'User' AND column_name IN ('supabaseAuthId','tokenVersion','passwordHash')`
    );
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    record(by.supabaseAuthId ? 'PASS' : 'FAIL', 'migration applied: User.supabaseAuthId exists', by.supabaseAuthId ? '' : 'run: npm --prefix server run prisma:migrate:deploy');
    record(by.tokenVersion ? 'PASS' : 'FAIL', 'migration applied: User.tokenVersion exists');
    record(by.passwordHash === 'YES' ? 'PASS' : 'FAIL', 'migration applied: User.passwordHash is nullable');
    if (by.supabaseAuthId) {
      const [t] = await prisma.$queryRawUnsafe(`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE "supabaseAuthId" IS NOT NULL)::int AS linked,
        count(*) FILTER (WHERE "supabaseAuthId" IS NULL AND role <> 'ADMIN' AND "isEmailVerified")::int AS legacy_flagged_verified,
        count(*) FILTER (WHERE role = 'ADMIN')::int AS admins FROM "User"`);
      console.log(`   users: ${t.total} total, ${t.linked} linked to Supabase Auth, ${t.admins} admin(s)`);
      record(t.legacy_flagged_verified ? 'WARN' : 'PASS', 'legacy accounts flagged verified without verification', `${t.legacy_flagged_verified} (preview/apply with scripts/reset-legacy-email-verification.js)`);
    }
  } catch (e) {
    record('FAIL', 'database reachable', e.message.split('\n').pop().slice(0, 140));
  } finally {
    await prisma.$disconnect();
  }
}

async function supa(pathAndQuery, { key, method = 'GET', body, redirect } = {}) {
  return fetch(`${strip(env.SUPABASE_URL)}${pathAndQuery}`, {
    method,
    redirect: redirect || 'follow',
    headers: { apikey: key || env.SUPABASE_ANON_KEY, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function checkSupabase() {
  console.log('\n== 3. Supabase Auth (live project, no users created) ==');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return record('SKIP', 'Supabase checks', 'SUPABASE_URL / SUPABASE_ANON_KEY missing');
  try {
    const r = await supa('/auth/v1/settings');
    if (!r.ok) return record('FAIL', 'Supabase Auth reachable with the anon key', `HTTP ${r.status}`);
    const s = await r.json();
    record('PASS', 'Supabase Auth reachable with the anon key');
    record(s.external && s.external.email ? 'PASS' : 'FAIL', 'Email provider enabled');
    record(s.mailer_autoconfirm === false ? 'PASS' : 'FAIL', '"Confirm email" is ON', s.mailer_autoconfirm ? 'autoconfirm is on: registration will refuse (EMAIL_CONFIRMATION_DISABLED)' : '');
    record(s.disable_signup === false ? 'PASS' : 'FAIL', 'sign-ups are allowed', s.disable_signup ? 'new users are disabled in Supabase' : '');
    record(s.external && s.external.google ? 'PASS' : 'FAIL', 'Google provider enabled');
  } catch (e) {
    return record('FAIL', 'Supabase Auth reachable', e.message);
  }

  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const r = await supa('/auth/v1/admin/users?page=1&per_page=1', { key: env.SUPABASE_SERVICE_ROLE_KEY });
      record(r.ok ? 'PASS' : 'FAIL', 'service-role key is accepted by the Admin API', r.ok ? '' : `HTTP ${r.status} (wrong key or wrong project?)`);
    } catch (e) {
      record('FAIL', 'service-role key check', e.message);
    }
  }

  // Google: ask Supabase to start the flow and look at where it would send the browser.
  try {
    const callback = `${strip(env.SERVER_PUBLIC_URL || '')}/api/auth/google/callback`;
    const r = await supa(`/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(callback)}`, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    if (r.status >= 300 && r.status < 400 && loc.startsWith('https://accounts.google.com/')) {
      const u = new URL(loc);
      record('PASS', 'Google authorize redirect works', 'Supabase hands the browser to Google');
      record(u.searchParams.get('client_id') ? 'PASS' : 'FAIL', 'Google client ID is configured in Supabase');
      console.log(`   Google Cloud must list this authorized redirect URI: ${u.searchParams.get('redirect_uri')}`);
    } else {
      record('FAIL', 'Google authorize redirect works', `HTTP ${r.status} ${loc.slice(0, 80)}`);
    }
  } catch (e) {
    record('FAIL', 'Google authorize probe', e.message);
  }

  // Dashboard-only settings via the Management API (read-only), when the operator supplies a token.
  if (env.SUPABASE_ACCESS_TOKEN && env.SUPABASE_PROJECT_REF) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(env.SUPABASE_PROJECT_REF)}/config/auth`, {
        headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }
      });
      if (!r.ok) return record('FAIL', 'Management API auth config readable', `HTTP ${r.status}`);
      const c = await r.json();
      const allow = String(c.uri_allow_list || '').split(',').map((x) => x.trim());
      const need = [`${strip(env.CLIENT_URL)}/pages/auth.html`, `${strip(env.SERVER_PUBLIC_URL)}/api/auth/google/callback`];
      for (const url of need) record(allow.includes(url) ? 'PASS' : 'FAIL', `Redirect URL allow-listed: ${url}`);
      record(strip(c.site_url) === strip(env.CLIENT_URL) ? 'PASS' : 'WARN', 'Site URL equals CLIENT_URL', `Site URL is ${c.site_url}`);
      record(c.smtp_host ? 'PASS' : 'FAIL', 'custom SMTP configured', c.smtp_host ? '' : 'built-in mailer only emails your own team members, 2/hour');
    } catch (e) {
      record('FAIL', 'Management API check', e.message);
    }
  } else {
    record('SKIP', 'Site URL / redirect allow-list / SMTP', 'not readable via the public API: verify in the dashboard, or set SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF in your shell');
  }

  if (probe) await passwordHashProbe();
}

async function passwordHashProbe() {
  console.log('\n== 4. password_hash import probe (creates then deletes one unconfirmed throwaway user; sends no email) ==');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return record('SKIP', 'probe', 'service-role key missing');
  const bcrypt = require('bcryptjs');
  const email = `lh-probe-${Date.now()}@example.com`; // reserved domain, never delivered
  const password = `Probe-${Math.random().toString(36).slice(2)}-Aa1`;
  let id;
  try {
    const created = await supa('/auth/v1/admin/users', {
      key: env.SUPABASE_SERVICE_ROLE_KEY, method: 'POST',
      body: { email, password_hash: await bcrypt.hash(password, 10), email_confirm: false }
    });
    if (!created.ok) return record('FAIL', 'admin.createUser with password_hash accepted', `HTTP ${created.status} ${(await created.text()).slice(0, 120)}`);
    id = (await created.json()).id;
    record('PASS', 'admin.createUser with password_hash accepted');
    // Correct password + unconfirmed email => "email_not_confirmed". Hash ignored => "invalid_credentials".
    const login = await supa('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    const body = await login.json().catch(() => ({}));
    const code = body.error_code || body.code || '';
    record(code === 'email_not_confirmed' ? 'PASS' : 'FAIL', 'provider recognises the imported bcrypt hash', `provider replied ${login.status} ${code}`);
  } catch (e) {
    record('FAIL', 'password_hash probe', e.message);
  } finally {
    if (id) {
      const del = await supa(`/auth/v1/admin/users/${id}`, { key: env.SUPABASE_SERVICE_ROLE_KEY, method: 'DELETE' });
      record(del.ok ? 'PASS' : 'WARN', 'throwaway probe user deleted', del.ok ? '' : `delete it manually: ${email}`);
    }
  }
}

(async () => {
  await checkEnv();
  await checkDatabase();
  await checkSupabase();
  const fails = results.filter((r) => r === 'FAIL').length;
  const warns = results.filter((r) => r === 'WARN').length;
  console.log(`\n${fails ? 'NOT READY' : 'READY for the manual tests'}: ${fails} failure(s), ${warns} warning(s). These checks do not prove email delivery - run the manual tests.`);
  process.exitCode = fails ? 1 : 0;
})();
