const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  register,
  login,
  logout,
  getMe,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  googleStart,
  googleCallback
} = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

const buildLimiter = (max, message) =>
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message }
  });

// Strict rate limit: max 10 attempts per IP per 15 minutes on credential endpoints
const authLimiter = buildLimiter(10, 'Too many authentication attempts from this IP. Please try again after 15 minutes.');
// Endpoints that send email: keep them well below the provider's own email limits
const emailLimiter = buildLimiter(5, 'Too many email requests from this IP. Please try again after 15 minutes.');
// Link-token endpoints and OAuth redirects
const linkLimiter = buildLimiter(30, 'Too many requests from this IP. Please try again after 15 minutes.');

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/logout', linkLimiter, logout);
router.get('/me', protect, getMe);

router.post('/verify-email', linkLimiter, verifyEmail);
router.post('/resend-verification', emailLimiter, resendVerification);
router.post('/forgot-password', emailLimiter, forgotPassword);
router.post('/reset-password', linkLimiter, resetPassword);

router.get('/google', linkLimiter, googleStart);
router.get('/google/callback', linkLimiter, googleCallback);

module.exports = router;
