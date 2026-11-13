const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { isSessionCurrent } = require('../services/authTokens');

const mapRole = (role) => {
  switch (role) {
    case 'WORKER':
      return 'Worker';
    case 'ADMIN':
      return 'Admin';
    default:
      return 'Customer';
  }
};

const buildUserSummary = (user) => ({
  id: user.id,
  _id: user.id,
  name: user.name,
  email: user.email,
  role: mapRole(user.role),
  avatarUrl: user.avatarUrl,
  phone: user.phone,
  isActive: user.isActive,
  isEmailVerified: user.isEmailVerified
});

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const pUser = await prisma.user.findUnique({
        where: { id: String(decoded.id) }
      });

      if (!pUser) {
        return res.status(401).json({ success: false, message: 'Not authorized, user not found' });
      }

      // Token revoked by logout / password reset
      if (!isSessionCurrent(decoded, pUser)) {
        return res.status(401).json({ success: false, message: 'Not authorized, session expired. Please log in again.' });
      }

      if (pUser.isActive === false) {
        return res.status(403).json({ success: false, message: 'This account has been deactivated.' });
      }

      if (pUser.isEmailVerified === false) {
        return res.status(403).json({
          success: false,
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Please verify your email address to continue.'
        });
      }

      req.user = buildUserSummary(pUser);
      return next();
    } catch (error) {
      console.error('[Auth Middleware] Token error:', error);
      return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, no token provided' });
  }
};

// Grant access to specific roles (requires protect first)
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role ${req.user ? req.user.role : 'unauthenticated'} is not authorized to access this route`
      });
    }
    next();
  };
};

// Restricts route from specific roles if authenticated
// If a user presents credentials belonging to a forbidden role (e.g. Worker accessing Find Workers),
// reject with 403 Forbidden. Unauthenticated prospective customers and permitted roles are allowed.
const forbidRoles = (...forbiddenRoles) => {
  return async (req, res, next) => {
    let token;
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      try {
        token = req.headers.authorization.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const pUser = await prisma.user.findUnique({ where: { id: String(decoded.id) } });
        if (pUser && isSessionCurrent(decoded, pUser) && pUser.isActive !== false && pUser.isEmailVerified !== false) {
          req.user = { id: pUser.id, role: mapRole(pUser.role) };
        }
      } catch (error) {
        // Invalid or expired token - proceed as unauthenticated visitor
      }
    }

    if (req.user && forbiddenRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. The 'Find Workers' directory is restricted to Customer (Hire Worker) accounts.`
      });
    }

    next();
  };
};

// Attaches req.user when a valid, current token is presented, but never rejects: for public routes whose
// response may differ for the owner / an admin / a customer with history.
const optionalAuth = async (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      const decoded = jwt.verify(req.headers.authorization.split(' ')[1], process.env.JWT_SECRET);
      const pUser = await prisma.user.findUnique({ where: { id: String(decoded.id) } });
      if (pUser && isSessionCurrent(decoded, pUser) && pUser.isActive !== false && pUser.isEmailVerified !== false) {
        req.user = buildUserSummary(pUser);
      }
    } catch (error) {
      // Invalid or expired token: treat as an anonymous visitor
    }
  }
  next();
};

module.exports = { protect, authorize, forbidRoles, optionalAuth };
