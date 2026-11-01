// Startup environment validation. A pure function (validateEnv) so it can be unit-tested, plus helpers shared by
// server.js. In production every secret that guards money, sessions, storage or identity documents must be present and
// must not be a placeholder or a development default; anything else stops the server with a clear message instead of
// silently falling back. Outside production the same problems are warnings (so local development stays easy), except
// for the two values nothing can run without.
const PLACEHOLDER = /replace[_-]?with|your[_-]|changeme|change[_-]me|example\.supabase|your-project|<[^>]+>|xxxx/i;
const WEAK_SECRETS = new Set(['secret', 'testsecret', 'test-secret', 'ui-test-secret', 'jwt_secret', 'jwtsecret', 'password', 'localhire', 'development', 'dev', 'changeme', 'letmein']);
const KNOWN_ENVS = new Set(['development', 'test', 'production']);

const val = (env, k) => String(env[k] === undefined || env[k] === null ? '' : env[k]).trim();
const isPlaceholder = (v) => !v || PLACEHOLDER.test(v);
const isLocalHost = (host) => /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i.test(host);
const parseUrl = (v) => { try { return new URL(v); } catch (e) { return null; } };
const b64urlBytes = (s) => { try { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').length; } catch (e) { return 0; } };

const isProduction = (env = process.env) => String(env.NODE_ENV || '').trim() === 'production';

// TRUST_PROXY: number of proxy hops ("1"), "true"/"false", or a comma list of trusted addresses/CIDRs.
const parseTrustProxy = (raw) => {
  const v = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!v || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

const validateEnv = (env = process.env) => {
  const errors = []; const warnings = [];
  const prod = isProduction(env);
  const nodeEnv = val(env, 'NODE_ENV');
  const need = (cond, msg) => { if (!cond) (prod ? errors : warnings).push(msg); };       // production-critical
  const always = (cond, msg) => { if (!cond) errors.push(msg); };                          // wrong in every environment

  if (nodeEnv && !KNOWN_ENVS.has(nodeEnv)) errors.push(`NODE_ENV="${nodeEnv}" is not one of development, test, production. An unknown value would silently run with development behaviour.`);
  if (!nodeEnv) warnings.push('NODE_ENV is not set: running with development behaviour. Set NODE_ENV=production on every deployed server (staging included).');

  // Required everywhere
  always(Boolean(val(env, 'JWT_SECRET')), 'JWT_SECRET is not set. Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  always(Boolean(val(env, 'DATABASE_URL')), 'DATABASE_URL is not set.');

  // Session secret strength
  const jwt = val(env, 'JWT_SECRET');
  if (jwt) {
    if (prod) {
      if (isPlaceholder(jwt) || WEAK_SECRETS.has(jwt.toLowerCase())) errors.push('JWT_SECRET is a placeholder or a well-known development value. Anyone could forge sessions. Generate a random 32-byte value.');
      else if (jwt.length < 32) errors.push('JWT_SECRET is shorter than 32 characters. Use at least 32 random bytes.');
    } else if (isPlaceholder(jwt) || WEAK_SECRETS.has(jwt.toLowerCase()) || jwt.length < 32) warnings.push('JWT_SECRET is weak or a placeholder (acceptable for local development only).');
  }

  // Database
  const db = val(env, 'DATABASE_URL');
  if (db) {
    need(!isPlaceholder(db), 'DATABASE_URL still contains placeholder text.');
    const u = parseUrl(db.replace(/^postgres(ql)?:/, 'http:'));
    if (prod && u && isLocalHost(u.hostname)) warnings.push('DATABASE_URL points at localhost in production. Confirm this is intentional.');
  }
  if (prod && !val(env, 'DIRECT_URL')) warnings.push('DIRECT_URL is not set. It is only needed where you run "prisma migrate deploy" (migrations cannot use the pooled connection).');

  // Supabase (authentication provider, email, and storage for photos and identity documents)
  const sUrl = val(env, 'SUPABASE_URL');
  need(Boolean(sUrl) && !isPlaceholder(sUrl), 'SUPABASE_URL is missing or a placeholder (required for sign-in, email and file storage).');
  if (sUrl && !isPlaceholder(sUrl)) {
    const u = parseUrl(sUrl);
    need(Boolean(u) && u.protocol === 'https:', 'SUPABASE_URL must be an https URL.');
  }
  for (const k of ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) need(Boolean(val(env, k)) && !isPlaceholder(val(env, k)), `${k} is missing or a placeholder.`);
  if (val(env, 'SUPABASE_ANON_KEY') && val(env, 'SUPABASE_ANON_KEY') === val(env, 'SUPABASE_SERVICE_ROLE_KEY')) errors.push('SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are identical. The service-role key must be the separate secret key.');

  // Public URLs (email links, OAuth return URLs, Secure cookies)
  for (const k of ['CLIENT_URL', 'SERVER_PUBLIC_URL']) {
    const v = val(env, k);
    need(Boolean(v) && !isPlaceholder(v), `${k} is not set.`);
    if (v) {
      const u = parseUrl(v);
      if (!u) errors.push(`${k} is not a valid URL.`);
      else if (prod && u.protocol !== 'https:') errors.push(`${k} must use https in production (OAuth cookies are Secure and email links must be safe).`);
      else if (prod && isLocalHost(u.hostname)) errors.push(`${k} points at localhost in production.`);
    }
  }

  // CORS
  const origins = val(env, 'ALLOWED_ORIGIN').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) {
    if (o === '*') errors.push('ALLOWED_ORIGIN must not be "*" (credentials are allowed). List exact origins.');
    else if (prod && !/^https:\/\//i.test(o)) errors.push(`ALLOWED_ORIGIN contains a non-https origin in production: ${o}`);
  }

  // Razorpay
  const keyId = val(env, 'RAZORPAY_KEY_ID'); const keySecret = val(env, 'RAZORPAY_KEY_SECRET'); const whSecret = val(env, 'RAZORPAY_WEBHOOK_SECRET');
  const keyOk = Boolean(keyId && keySecret) && !isPlaceholder(keyId) && !isPlaceholder(keySecret);
  need(keyOk, 'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are missing or placeholders: customer payments would be unavailable.');
  if (keyOk && !/^rzp_(test|live)_/.test(keyId)) errors.push('RAZORPAY_KEY_ID does not look like a Razorpay key (expected rzp_test_... or rzp_live_...).');
  if (keyOk && prod && /^rzp_test_/.test(keyId)) warnings.push('RAZORPAY_KEY_ID is a TEST key: this deployment will not take real money. Expected for staging; for launch use live keys.');
  if (keyOk) need(Boolean(whSecret) && !isPlaceholder(whSecret), 'RAZORPAY_WEBHOOK_SECRET is missing or a placeholder: payment webhooks (the safety net for lost browser callbacks, refunds and failures) would be rejected.');
  if (whSecret && keySecret && whSecret === keySecret) warnings.push('RAZORPAY_WEBHOOK_SECRET equals RAZORPAY_KEY_SECRET. Use a separate webhook secret.');

  const payout = (val(env, 'PAYOUT_MODE') || 'LEDGER_ONLY').toUpperCase();
  if (!['LEDGER_ONLY', 'ROUTE'].includes(payout)) errors.push(`PAYOUT_MODE="${val(env, 'PAYOUT_MODE')}" is not LEDGER_ONLY or ROUTE.`);
  else if (payout === 'ROUTE' && prod) warnings.push('PAYOUT_MODE=ROUTE: only valid if Razorpay has enabled Route for your account. Run "npm --prefix server run razorpay:route-check" and complete a real test transfer first.');

  // Pricing numbers
  for (const k of ['PLATFORM_FEE_PERCENT', 'PLATFORM_FEE_TAX_PERCENT', 'WORKER_COMMISSION_PERCENT', 'CUSTOMER_CANCELLATION_FEE_PERCENT']) {
    const v = val(env, k);
    if (v !== '' && !(Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100)) errors.push(`${k}="${v}" must be a number between 0 and 100.`);
  }

  // Web Push (optional feature: all three or none)
  const vPub = val(env, 'VAPID_PUBLIC_KEY'); const vPriv = val(env, 'VAPID_PRIVATE_KEY'); const vSub = val(env, 'VAPID_SUBJECT');
  const vSet = [vPub, vPriv, vSub].filter(Boolean).length;
  if (vSet === 0) { if (prod) warnings.push('VAPID keys are not set: browser push notifications are switched off (in-app notifications still work).'); }
  else if (vSet < 3) errors.push('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must all be set, or all left empty.');
  else {
    if (b64urlBytes(vPub) !== 65) errors.push('VAPID_PUBLIC_KEY is not a valid P-256 public key (expected 65 bytes, base64url). Generate: npm --prefix server run push:generate-keys');
    if (b64urlBytes(vPriv) !== 32) errors.push('VAPID_PRIVATE_KEY is not a valid P-256 private key (expected 32 bytes, base64url).');
    if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(vSub)) errors.push('VAPID_SUBJECT must be "mailto:you@example.com" or an https URL.');
  }

  // Proxy / HTTPS
  const trust = parseTrustProxy(env.TRUST_PROXY);
  if (prod && trust === false) warnings.push('TRUST_PROXY is not set. Behind a load balancer or platform proxy, every visitor would share one IP (rate limits break) and HTTPS cannot be detected. Set TRUST_PROXY=1 (number of proxies in front of the app).');
  if (prod && trust === true) warnings.push('TRUST_PROXY=true trusts every X-Forwarded-For header, so clients can spoof their IP. Prefer the number of proxy hops (for example 1).');

  // Misc
  const tz = val(env, 'BUSINESS_TIMEZONE');
  if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (e) { errors.push(`BUSINESS_TIMEZONE="${tz}" is not a valid IANA time zone.`); } }
  const port = val(env, 'PORT');
  if (port && !/^\d{1,5}$/.test(port)) errors.push(`PORT="${port}" is not a valid port number.`);
  if (prod && val(env, 'ADMIN_PASSWORD') && !isPlaceholder(val(env, 'ADMIN_PASSWORD'))) warnings.push('ADMIN_PASSWORD is set in the runtime environment. It is only needed when provisioning the admin account; remove it afterwards.');

  return { production: prod, errors, warnings };
};

// Logs the result and exits the process on errors. Never prints a secret value, only variable names.
const enforce = (env = process.env, log = console, exit = (c) => process.exit(c)) => {
  const r = validateEnv(env);
  if (String(env.NODE_ENV || '').trim() !== 'test') r.warnings.forEach((w) => log.warn(`[Config] WARNING: ${w}`));
  if (r.errors.length) {
    r.errors.forEach((e) => log.error(`[FATAL] ${e}`));
    log.error(`[FATAL] ${r.errors.length} configuration problem(s). Refusing to start${r.production ? ' in production' : ''}. See DEPLOYMENT.md.`);
    exit(1);
  }
  return r;
};

module.exports = { validateEnv, enforce, isProduction, parseTrustProxy, isPlaceholder };
