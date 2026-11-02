// LocalHire authentication.
//
// Identity provider: the project's existing Supabase project (Supabase Auth). It owns email
// delivery, email verification, password reset and Google OAuth. The Prisma "User" table remains
// the single user table (linked through User.supabaseAuthId) and the app's own JWT remains the
// session credential for every existing route, so roles and all other features are untouched.
//
// Nothing here simulates verification: an account is only marked verified after Supabase reports
// a confirmed email (emailed link, password-recovery link, or a Google-verified address).
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const { signSessionToken, isSessionCurrent } = require('../services/authTokens');
const { disconnectUserSockets } = require('../trackingState');

const ALLOWED_PUBLIC_ROLES = new Set(['CUSTOMER', 'WORKER']);
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt / Supabase hard limit
const OAUTH_COOKIE = 'lh_oauth';
const OAUTH_COOKIE_TTL_SEC = 10 * 60;

const GENERIC_RESET_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';
const GENERIC_RESEND_MESSAGE = 'If that account is awaiting verification, a new verification email has been sent.';
const REGISTERED_MESSAGE = 'Account created. We sent a verification link to your email. Verify it, then log in.';

const normalizeRole = (role) => {
  const key = String(role || 'CUSTOMER').trim().toUpperCase();
  return ALLOWED_PUBLIC_ROLES.has(key) ? key : 'CUSTOMER';
};

const normalizePhone = (phone) => {
  const value = String(phone || '').trim();
  return value || '+91 00000 00000';
};

const mapPrismaRole = (role) => {
  switch (role) {
    case 'WORKER':
      return 'Worker';
    case 'ADMIN':
      return 'Admin';
    default:
      return 'Customer';
  }
};

const serializeUser = (user) => ({
  id: user.id,
  _id: user.id,
  email: user.email,
  name: user.name,
  phone: user.phone,
  role: mapPrismaRole(user.role),
  avatarUrl: user.avatarUrl,
  isActive: user.isActive,
  isEmailVerified: user.isEmailVerified,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt
});

// ── Validation ───────────────────────────────────────────────────────────────

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const isValidEmail = (email) => {
  if (!email || email.length > 254) return false;
  const [local] = email.split('@');
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return EMAIL_PATTERN.test(email);
};

const passwordProblem = (password) => {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters long.`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Password must be at most ${PASSWORD_MAX} characters long.`;
  }
  return null;
};

// ── URLs (from configuration, never from the request) ────────────────────────

const stripSlash = (url) => String(url).replace(/\/+$/, '');
const clientBaseUrl = () => stripSlash(process.env.CLIENT_URL || `http://localhost:${process.env.PORT || 5000}`);
const serverBaseUrl = () => stripSlash(process.env.SERVER_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`);
// One page handles every email/OAuth return so only one frontend URL has to be allow-listed in Supabase.
const authPageUrl = () => `${clientBaseUrl()}/pages/auth.html`;
const googleCallbackUrl = () => `${serverBaseUrl()}/api/auth/google/callback`;

// ── Supabase helpers ─────────────────────────────────────────────────────────

class AuthFlowError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const requireAuthProvider = () => {
  if (!supabaseConfig.isAuthConfigured()) {
    throw new AuthFlowError(
      503,
      'Email authentication is not configured on this server. The administrator must set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.',
      'AUTH_PROVIDER_NOT_CONFIGURED'
    );
  }
};

const errCode = (error) => String((error && (error.code || error.error_code)) || '').toLowerCase();
const errText = (error) => String((error && error.message) || '').toLowerCase();

const isEmailNotConfirmed = (error) => errCode(error) === 'email_not_confirmed' || errText(error).includes('email not confirmed');
const isRateLimited = (error) =>
  error && (error.status === 429 || errCode(error).includes('rate_limit') || errText(error).includes('rate limit'));

const providerFailure = (error, fallback) => {
  if (isRateLimited(error)) {
    return new AuthFlowError(429, 'Please wait about a minute before requesting another email.', 'EMAIL_RATE_LIMITED');
  }
  console.error(`[Auth] Supabase error (${fallback}):`, error && (error.code || error.message));
  return new AuthFlowError(502, `${fallback} The authentication provider rejected the request.`, 'AUTH_PROVIDER_ERROR');
};

const findUserByEmail = (email) => prisma.user.findUnique({ where: { email } });

// Validates a Supabase access token (from an email link) with the provider and returns its user.
const getSupabaseUserFromToken = async (accessToken) => {
  requireAuthProvider();
  if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096) {
    throw new AuthFlowError(400, 'This link is invalid or has expired. Please request a new one.', 'LINK_INVALID');
  }
  const { data, error } = await supabaseConfig.supabaseAdmin.auth.getUser(accessToken);
  if (error || !data || !data.user) {
    throw new AuthFlowError(400, 'This link is invalid or has expired. Please request a new one.', 'LINK_INVALID');
  }
  return data.user;
};

// Creates the Supabase Auth identity for an account that predates Supabase Auth, keeping its
// existing password working (bcrypt hash is imported) and linking it to the same User row.
const linkLegacyAccountToProvider = async (user) => {
  requireAuthProvider();
  const attributes = {
    email: user.email,
    email_confirm: user.isEmailVerified === true,
    user_metadata: { name: user.name }
  };
  if (user.passwordHash) attributes.password_hash = user.passwordHash;

  const { data, error } = await supabaseConfig.supabaseAdmin.auth.admin.createUser(attributes);
  if (error || !data || !data.user) {
    if (error && (errCode(error) === 'email_exists' || errText(error).includes('already been registered'))) {
      throw new AuthFlowError(409, 'This email is already registered with the authentication provider. Use "Forgot password" to recover access.', 'AUTH_IDENTITY_CONFLICT');
    }
    throw providerFailure(error, 'Could not prepare your account for verification.');
  }

  return prisma.user.update({ where: { id: user.id }, data: { supabaseAuthId: data.user.id } });
};

const sendVerificationEmail = async (user) => {
  requireAuthProvider();
  let target = user;
  if (!target.supabaseAuthId) {
    target = await linkLegacyAccountToProvider(target);
  }
  const client = supabaseConfig.createAuthClient();
  const { error } = await client.auth.resend({
    type: 'signup',
    email: target.email,
    options: { emailRedirectTo: authPageUrl() }
  });
  if (error) throw providerFailure(error, 'Could not send the verification email.');
};

const sendResetEmail = async (user) => {
  requireAuthProvider();
  let target = user;
  if (!target.supabaseAuthId) {
    target = await linkLegacyAccountToProvider(target);
  }
  const client = supabaseConfig.createAuthClient();
  const { error } = await client.auth.resetPasswordForEmail(target.email, { redirectTo: authPageUrl() });
  if (error) throw providerFailure(error, 'Could not send the password reset email.');
};

const sessionResponse = (user) => ({
  success: true,
  token: signSessionToken(user),
  user: serializeUser(user)
});

const handleError = (res, error, logLabel) => {
  if (error instanceof AuthFlowError) {
    return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  console.error(`[Auth Controller] ${logLabel}:`, error);
  return res.status(500).json({ success: false, message: `Server error during ${logLabel.toLowerCase()}` });
};

// ── Register ─────────────────────────────────────────────────────────────────

// @desc    Register a new user; a verification email is sent, no session is issued
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res) => {
  try {
    const { name, email, password, role, phone } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide name, email, and password' });
    }

    const requestedRole = typeof role === 'string' ? role.trim().toUpperCase() : '';
    if (role !== undefined && requestedRole && !ALLOWED_PUBLIC_ROLES.has(requestedRole)) {
      return res.status(400).json({
        success: false,
        message: 'Public registration is limited to Customer and Worker roles.'
      });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const weak = passwordProblem(password);
    if (weak) {
      return res.status(400).json({ success: false, message: weak });
    }

    requireAuthProvider();

    const existing = await findUserByEmail(normalizedEmail);
    if (existing) {
      if (existing.isEmailVerified) {
        return res.status(400).json({ success: false, message: 'User already exists with this email' });
      }
      // Registered but never verified: re-send the link. The password is NOT changed here,
      // so a third party cannot take over a pending account by re-registering it.
      await sendVerificationEmail(existing);
      return res.status(201).json({ success: true, requiresEmailVerification: true, email: normalizedEmail, message: REGISTERED_MESSAGE });
    }

    const client = supabaseConfig.createAuthClient();
    const { data, error } = await client.auth.signUp({
      email: normalizedEmail,
      password,
      options: { emailRedirectTo: authPageUrl(), data: { name: String(name).trim() } }
    });

    if (error) {
      const code = errCode(error);
      if (code === 'weak_password') {
        return res.status(400).json({ success: false, message: 'That password is too weak. Please choose a stronger one.' });
      }
      if (code === 'email_address_invalid' || code === 'validation_failed') {
        return res.status(400).json({ success: false, message: 'That email address was not accepted. Please use a valid email.' });
      }
      throw providerFailure(error, 'Could not create your account.');
    }

    const authUser = data && data.user;
    if (!authUser) {
      throw providerFailure(null, 'Could not create your account.');
    }

    // Supabase "Confirm email" is switched off: the address would count as confirmed without
    // anyone verifying it. Refuse to proceed and remove the identity rather than fake verification.
    if (data.session || authUser.email_confirmed_at) {
      await supabaseConfig.supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
      throw new AuthFlowError(
        503,
        'Email verification is disabled in the authentication provider. The administrator must enable "Confirm email" in Supabase Auth settings before registration can be used.',
        'EMAIL_CONFIRMATION_DISABLED'
      );
    }

    // Supabase hides already-registered emails by returning a user with no identities.
    if (Array.isArray(authUser.identities) && authUser.identities.length === 0) {
      throw new AuthFlowError(409, 'This email is already registered. Please log in or use "Forgot password".', 'AUTH_IDENTITY_CONFLICT');
    }

    let user;
    try {
      user = await prisma.user.create({
        data: {
          name: String(name).trim(),
          email: normalizedEmail,
          passwordHash: null,
          supabaseAuthId: authUser.id,
          phone: normalizePhone(phone),
          role: normalizeRole(role),
          isActive: true,
          isEmailVerified: false,
          avatarUrl: null // no photo until the user uploads one
        }
      });
    } catch (dbError) {
      // Don't leave a dangling provider identity behind a failed local insert.
      await supabaseConfig.supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
      throw dbError;
    }

    return res.status(201).json({
      success: true,
      requiresEmailVerification: true,
      email: user.email,
      message: REGISTERED_MESSAGE
    });
  } catch (error) {
    return handleError(res, error, 'Registration');
  }
};

// ── Login / logout ───────────────────────────────────────────────────────────

const unverifiedResponse = (res, email) =>
  res.status(403).json({
    success: false,
    code: 'EMAIL_NOT_VERIFIED',
    email,
    message: 'Please verify your email address before logging in. Check your inbox or request a new link.'
  });

// @desc    Login user & get token
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password || typeof password !== 'string') {
      return res.status(400).json({ success: false, message: 'Please provide email and password' });
    }

    const normalizedEmail = normalizeEmail(email);
    const user = await findUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    let current = user;

    if (user.supabaseAuthId) {
      // Credentials live in Supabase Auth; it also enforces confirmed email.
      requireAuthProvider();
      const client = supabaseConfig.createAuthClient();
      const { data, error } = await client.auth.signInWithPassword({ email: normalizedEmail, password });

      if (error) {
        if (isEmailNotConfirmed(error)) return unverifiedResponse(res, normalizedEmail);
        if (isRateLimited(error)) {
          return res.status(429).json({ success: false, message: 'Too many attempts. Please wait a few minutes and try again.' });
        }
        if (error.status && error.status >= 500) throw providerFailure(error, 'Could not log you in.');

        // The provider rejected the password. A linked legacy account may still hold its original
        // password only locally (e.g. it was linked through Google, which carries no password, or
        // the provider did not apply the imported hash). Accept the local bcrypt hash in that case;
        // it is cleared on password reset.
        const localMatch = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
        if (!localMatch) {
          return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        if (!user.isEmailVerified) return unverifiedResponse(res, normalizedEmail);
      } else {
        const authUser = data && data.user;
        if (!authUser || authUser.id !== user.supabaseAuthId) {
          return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        if (!authUser.email_confirmed_at) return unverifiedResponse(res, normalizedEmail);

        if (!user.isEmailVerified) {
          current = await prisma.user.update({ where: { id: user.id }, data: { isEmailVerified: true } });
        }
      }
    } else {
      // Account that predates Supabase Auth: verify the stored bcrypt hash locally.
      const isMatch = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }
      if (!user.isEmailVerified) return unverifiedResponse(res, normalizedEmail);
    }

    if (current.isActive === false) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated.' });
    }

    return res.json(sessionResponse(current));
  } catch (error) {
    return handleError(res, error, 'Login');
  }
};

// @desc    Log out: revoke every app token issued for this user
// @route   POST /api/auth/logout
// @access  Public (a stale or expired token must still be able to log out)
exports.logout = async (req, res) => {
  try {
    const header = req.headers && req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET, { ignoreExpiration: true });
        const user = await prisma.user.findUnique({ where: { id: String(decoded.id) } });
        if (user && isSessionCurrent(decoded, user)) {
          await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
          disconnectUserSockets(user.id);
        }
      } catch (tokenError) {
        // Invalid token: nothing to revoke. The client clears its own state regardless.
      }
    }
    return res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    return handleError(res, error, 'Logout');
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: String(req.user.id || req.user._id) } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User profile not found' });
    }

    res.json({
      success: true,
      user: serializeUser(user)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error fetching user profile' });
  }
};

// ── Email verification ───────────────────────────────────────────────────────

// @desc    Complete email verification with the token from the emailed link; signs the user in
// @route   POST /api/auth/verify-email
// @access  Public
exports.verifyEmail = async (req, res) => {
  try {
    const authUser = await getSupabaseUserFromToken((req.body || {}).accessToken);

    if (!authUser.email_confirmed_at) {
      return res.status(400).json({ success: false, message: 'This email address has not been verified yet.', code: 'LINK_INVALID' });
    }

    let user = await prisma.user.findUnique({ where: { supabaseAuthId: authUser.id } });
    if (!user && authUser.email) {
      user = await findUserByEmail(normalizeEmail(authUser.email));
      if (user && user.supabaseAuthId && user.supabaseAuthId !== authUser.id) {
        return res.status(409).json({ success: false, message: 'This verification link does not match your account.', code: 'AUTH_IDENTITY_CONFLICT' });
      }
    }
    if (!user) {
      return res.status(404).json({ success: false, message: 'No LocalHire account matches this verification link.' });
    }
    if (user.isActive === false) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated.' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { isEmailVerified: true, supabaseAuthId: authUser.id }
    });

    return res.json(sessionResponse(updated));
  } catch (error) {
    return handleError(res, error, 'Email verification');
  }
};

// @desc    Send the verification email again
// @route   POST /api/auth/resend-verification
// @access  Public (response never reveals whether the account exists)
exports.resendVerification = async (req, res) => {
  try {
    const email = normalizeEmail((req.body || {}).email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    requireAuthProvider();

    const user = await findUserByEmail(email);
    if (user && !user.isEmailVerified && user.isActive !== false) {
      await sendVerificationEmail(user);
    }
    return res.json({ success: true, message: GENERIC_RESEND_MESSAGE });
  } catch (error) {
    return handleError(res, error, 'Resend verification');
  }
};

// ── Password reset ───────────────────────────────────────────────────────────

// @desc    Email a password reset link
// @route   POST /api/auth/forgot-password
// @access  Public (response never reveals whether the account exists)
exports.forgotPassword = async (req, res) => {
  try {
    const email = normalizeEmail((req.body || {}).email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    requireAuthProvider();

    const user = await findUserByEmail(email);
    if (user && user.isActive !== false) {
      try {
        await sendResetEmail(user);
      } catch (sendError) {
        if (sendError instanceof AuthFlowError && sendError.status === 429) throw sendError;
        // Don't let delivery details reveal that the account exists.
        console.error('[Auth Controller] Password reset email failed:', sendError.message);
      }
    }
    return res.json({ success: true, message: GENERIC_RESET_MESSAGE });
  } catch (error) {
    return handleError(res, error, 'Password reset request');
  }
};

// @desc    Set a new password using the token from the emailed recovery link
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
  try {
    const { accessToken, password } = req.body || {};

    const weak = passwordProblem(password);
    if (weak) {
      return res.status(400).json({ success: false, message: weak });
    }

    const authUser = await getSupabaseUserFromToken(accessToken);

    let user = await prisma.user.findUnique({ where: { supabaseAuthId: authUser.id } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No LocalHire account matches this reset link.' });
    }

    const { error } = await supabaseConfig.supabaseAdmin.auth.admin.updateUserById(authUser.id, { password });
    if (error) {
      if (errCode(error) === 'weak_password') {
        return res.status(400).json({ success: false, message: 'That password is too weak. Please choose a stronger one.' });
      }
      if (errCode(error) === 'same_password') {
        return res.status(400).json({ success: false, message: 'The new password must be different from your current one.' });
      }
      throw providerFailure(error, 'Could not update your password.');
    }

    // The provider is now the only credential store; drop any stale legacy hash and revoke
    // every session issued before the reset. Following the link proves ownership of the email.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: null,
        tokenVersion: { increment: 1 },
        ...(authUser.email_confirmed_at ? { isEmailVerified: true } : {})
      }
    });

    disconnectUserSockets(user.id);

    return res.json({ success: true, message: 'Password updated. You can now log in with your new password.' });
  } catch (error) {
    return handleError(res, error, 'Password reset');
  }
};

// ── Google OAuth (Supabase Auth, PKCE authorization-code flow) ───────────────

const parseCookies = (header) => {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
};

const oauthCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax', // the provider redirect back to us is a top-level GET
  secure: process.env.NODE_ENV === 'production',
  path: '/api/auth'
});

// supabase-js stores the PKCE code verifier through this adapter; we keep it in a signed,
// HttpOnly cookie so the callback (a separate request) can complete the exchange.
const createVerifierStorage = (initial = {}) => {
  const store = { ...initial };
  return {
    store,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; }
  };
};

const oauthFailure = (res, code) => {
  res.clearCookie(OAUTH_COOKIE, oauthCookieOptions());
  return res.redirect(`${authPageUrl()}#lh_error=${encodeURIComponent(code)}`);
};

// @desc    Start "Continue with Google"
// @route   GET /api/auth/google?role=Customer|Worker
// @access  Public
exports.googleStart = async (req, res) => {
  try {
    if (!supabaseConfig.isAuthConfigured()) return oauthFailure(res, 'not_configured');

    const rawRole = typeof req.query.role === 'string' ? req.query.role.trim().toUpperCase() : '';
    if (rawRole && !ALLOWED_PUBLIC_ROLES.has(rawRole)) return oauthFailure(res, 'invalid_role');

    const storage = createVerifierStorage();
    const client = supabaseConfig.createAuthClient({ flowType: 'pkce', persistSession: true, storage });
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: googleCallbackUrl(), skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } }
    });
    if (error || !data || !data.url) {
      console.error('[Auth Controller] Google OAuth start failed:', error && error.message);
      return oauthFailure(res, 'provider_error');
    }

    const signed = jwt.sign({ purpose: 'oauth', store: storage.store, role: rawRole || null }, process.env.JWT_SECRET, {
      expiresIn: OAUTH_COOKIE_TTL_SEC
    });
    res.cookie(OAUTH_COOKIE, signed, { ...oauthCookieOptions(), maxAge: OAUTH_COOKIE_TTL_SEC * 1000 });
    return res.redirect(data.url);
  } catch (error) {
    console.error('[Auth Controller] Google start error:', error);
    return oauthFailure(res, 'server_error');
  }
};

// @desc    Google/Supabase redirects here with ?code=...
// @route   GET /api/auth/google/callback
// @access  Public
exports.googleCallback = async (req, res) => {
  try {
    if (!supabaseConfig.isAuthConfigured()) return oauthFailure(res, 'not_configured');
    if (req.query.error) return oauthFailure(res, 'cancelled');

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const cookie = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
    if (!code || !cookie) return oauthFailure(res, 'session_expired');

    let state;
    try {
      state = jwt.verify(cookie, process.env.JWT_SECRET);
    } catch (e) {
      return oauthFailure(res, 'session_expired');
    }
    if (state.purpose !== 'oauth' || !state.store) return oauthFailure(res, 'session_expired');

    const storage = createVerifierStorage(state.store);
    const client = supabaseConfig.createAuthClient({ flowType: 'pkce', persistSession: true, storage });
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (error || !data || !data.session || !data.session.user) {
      console.error('[Auth Controller] Google code exchange failed:', error && error.message);
      return oauthFailure(res, 'exchange_failed');
    }

    const authUser = data.session.user;
    const email = normalizeEmail(authUser.email);
    const googleIdentity = (authUser.identities || []).find((i) => i.provider === 'google');
    const googleEmailVerified = googleIdentity
      ? googleIdentity.identity_data && googleIdentity.identity_data.email_verified !== false
      : false;

    // Only a Google-verified address may create or sign in to an account.
    if (!email || !authUser.email_confirmed_at || !googleEmailVerified) {
      return oauthFailure(res, 'email_unverified');
    }

    let user = await prisma.user.findUnique({ where: { supabaseAuthId: authUser.id } });
    let created = false;

    if (!user) {
      user = await findUserByEmail(email);
      if (user && user.supabaseAuthId && user.supabaseAuthId !== authUser.id && user.isEmailVerified) {
        // A different, already-verified identity owns this account: never silently re-point it.
        return oauthFailure(res, 'account_conflict');
      }
    }

    if (user) {
      if (user.isActive === false) return oauthFailure(res, 'account_disabled');
      // A credential on an account that was never verified (or that predates verification) may have
      // been set by someone other than the mailbox owner (pre-registration takeover). Google has now
      // proven ownership of the address, so drop the local password and revoke old sessions. Supabase
      // does the same for its own copy when it links an unconfirmed identity. Operator-provisioned
      // admins keep their password. Anyone affected can set a new one with "Forgot password".
      const credentialsUntrusted = !user.isEmailVerified || (!user.supabaseAuthId && user.role !== 'ADMIN');
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          supabaseAuthId: authUser.id,
          isEmailVerified: true,
          ...(credentialsUntrusted && user.passwordHash ? { passwordHash: null } : {}),
          ...(credentialsUntrusted ? { tokenVersion: { increment: 1 } } : {})
        }
      });
      if (credentialsUntrusted) disconnectUserSockets(user.id);
    } else {
      const role = state.role && ALLOWED_PUBLIC_ROLES.has(state.role) ? state.role : null;
      if (!role) {
        // No existing LocalHire account and no role chosen: remove the identity Google just
        // created in the provider so no orphan is left, and ask the user to sign up first.
        await supabaseConfig.supabaseAdmin.auth.admin.deleteUser(authUser.id).catch(() => {});
        return oauthFailure(res, 'no_account');
      }
      const meta = authUser.user_metadata || {};
      const displayName = String(meta.full_name || meta.name || email.split('@')[0]).trim();
      user = await prisma.user.create({
        data: {
          name: displayName,
          email,
          passwordHash: null,
          supabaseAuthId: authUser.id,
          phone: normalizePhone(null),
          role,
          isActive: true,
          isEmailVerified: true,
          avatarUrl: meta.avatar_url || meta.picture || null
        }
      });
      created = true;
    }

    res.clearCookie(OAUTH_COOKIE, oauthCookieOptions());
    // Fragment, not query string: it is never sent to a server or written to access logs.
    const fragment = `lh_token=${encodeURIComponent(signSessionToken(user))}${created ? '&lh_new=1' : ''}`;
    return res.redirect(`${authPageUrl()}#${fragment}`);
  } catch (error) {
    console.error('[Auth Controller] Google callback error:', error);
    return oauthFailure(res, 'server_error');
  }
};

// Exposed for unit tests only.
exports._internals = { isValidEmail, passwordProblem, parseCookies, createVerifierStorage };
