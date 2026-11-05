const express = require('express');
const rateLimit = require('express-rate-limit');
const { getHome, suggest } = require('../controllers/marketplaceController');
const { optionalAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

const suggestLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many searches. Please slow down for a moment.' }
});

router.get('/home', optionalAuth, getHome);
router.get('/suggest', suggestLimiter, suggest);

module.exports = router;
