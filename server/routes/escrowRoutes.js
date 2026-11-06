// Backwards-compatible entry points. The old "escrow" API (simulated funding, release, ledger) was replaced by
// /api/payments. Only the URLs an existing Razorpay dashboard may already point at are kept.
const express = require('express');
const { getConfig, webhook } = require('../controllers/paymentController');

const router = express.Router();

router.get('/razorpay/config', getConfig);
router.post('/razorpay/webhook', webhook);
router.get('/status', (req, res) => res.json({ success: true, message: 'Payments are handled by /api/payments.' }));

module.exports = router;
