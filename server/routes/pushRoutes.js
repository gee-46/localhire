// Web Push subscription management. The PRIVATE VAPID key is never returned by any route.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middlewares/authMiddleware');
const push = require('../services/pushService');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.PUSH_RATE_LIMIT_MAX) || 60, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please try again later.' } });

// Public: lets the browser know whether push is available at all and which application server key to use.
router.get('/config', (req, res) => {
  const publicKey = push.getPublicKey();
  res.json({ success: true, supported: Boolean(publicKey), publicKey });
});

router.get('/status', protect, async (req, res) => {
  res.json({ success: true, configured: push.isConfigured(), subscriptions: await push.countForUser(req.user.id) });
});

router.post('/subscribe', limiter, protect, async (req, res) => {
  if (!push.isConfigured()) return res.status(503).json({ success: false, message: 'Browser notifications are not configured on this server.', code: 'PUSH_NOT_CONFIGURED' });
  try {
    await push.subscribe(String(req.user.id), req.body && req.body.subscription, req.headers['user-agent']);
    return res.status(201).json({ success: true });
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ success: false, message: e.message });
    console.error('[Push] subscribe failed:', e);
    return res.status(500).json({ success: false, message: 'Could not save the subscription.' });
  }
});

router.post('/unsubscribe', limiter, protect, async (req, res) => {
  try {
    const removed = await push.unsubscribe(String(req.user.id), req.body && req.body.endpoint);
    return res.json({ success: true, removed });
  } catch (e) {
    console.error('[Push] unsubscribe failed:', e);
    return res.status(500).json({ success: false, message: 'Could not remove the subscription.' });
  }
});

module.exports = router;
