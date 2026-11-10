const express = require('express');
const rateLimit = require('express-rate-limit');
const { createReview, getWorkerReviews, getReceived, reportReview } = require('../controllers/reviewController');
const { protect, authorize } = require('../middlewares/authMiddleware');

const router = express.Router();

// Writing endpoints are limited per signed-in user (falling back to IP), so one account cannot spam reviews or reports.
const keyByUser = (req) => (req.user && req.user.id) || req.ip;
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: Number(process.env.REVIEW_RATE_LIMIT_MAX) || 20, standardHeaders: true, legacyHeaders: false, keyGenerator: keyByUser,
  message: { success: false, message: 'Too many review requests. Please wait a few minutes and try again.' }
});

// Public reads are limited per IP.
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: Number(process.env.REVIEW_READ_RATE_LIMIT_MAX) || 120, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});

// Only a customer can review (admins and professionals cannot), and only their own completed booking.
router.post('/', protect, authorize('Customer'), writeLimiter, createReview);
router.get('/received', protect, authorize('Worker'), getReceived);
router.post('/:id/report', protect, authorize('Worker'), writeLimiter, reportReview);
router.get('/worker/:workerId', readLimiter, getWorkerReviews);

module.exports = router;
