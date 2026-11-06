// Payments API. Customer, worker and admin surfaces are separate on purpose: each caller only ever sees their own side.
const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/paymentController');
const { protect, authorize } = require('../middlewares/authMiddleware');

const router = express.Router();

// Money endpoints are rate limited per IP (order creation hits the payment gateway).
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: Number(process.env.PAYMENT_RATE_LIMIT_MAX) || 30, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many payment attempts. Please wait a few minutes.' }
});

router.get('/config', c.getConfig);
router.post('/webhook', c.webhook);

// Customer
router.get('/history', protect, authorize('Customer'), c.history);
router.get('/booking/:bookingId/quote', protect, authorize('Customer'), c.quote);
router.post('/booking/:bookingId/order', orderLimiter, protect, authorize('Customer'), c.createOrder);
router.post('/booking/:bookingId/verify', orderLimiter, protect, authorize('Customer'), c.verify);
router.post('/booking/:bookingId/sync', orderLimiter, protect, authorize('Customer'), c.sync);
router.post('/booking/:bookingId/confirm-completion', protect, authorize('Customer'), c.confirmCompletion);
router.post('/booking/:bookingId/dispute', protect, authorize('Customer', 'Worker', 'Admin'), c.dispute);
router.get('/:paymentId', protect, authorize('Customer'), c.detail);

module.exports = router;
