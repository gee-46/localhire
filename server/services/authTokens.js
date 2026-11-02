// App session tokens. The app's own JWT remains the session credential for every existing
// route and for Socket.IO; Supabase Auth is the identity provider behind it.
const jwt = require('jsonwebtoken');

const SESSION_TTL = '30d';

// `tv` binds a token to User.tokenVersion so logout / password reset can revoke it server-side.
const signSessionToken = (user) =>
  jwt.sign({ id: user.id, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: SESSION_TTL });

// Tokens issued before tokenVersion existed carry no `tv` and are treated as version 0.
const isSessionCurrent = (decoded, user) => (decoded.tv || 0) === (user.tokenVersion || 0);

module.exports = { signSessionToken, isSessionCurrent, SESSION_TTL };
