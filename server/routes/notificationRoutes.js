const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const service = require('../services/notificationService');

const fail = (res, e) => {
  console.error('[Notification Routes]', e);
  return res.status(500).json({ success: false, message: 'Unable to process the notification request.' });
};

// GET /api/notifications?category=&unread=true&limit=&before=
router.get('/', protect, async (req, res) => {
  try {
    const r = await service.list(req.user.id, { category: req.query.category, unreadOnly: req.query.unread === 'true', limit: req.query.limit, before: req.query.before });
    return res.json({ success: true, ...r });
  } catch (e) { return fail(res, e); }
});

router.get('/unread-count', protect, async (req, res) => {
  try { return res.json({ success: true, unreadCount: await service.unreadCount(req.user.id) }); } catch (e) { return fail(res, e); }
});

router.post('/read-all', protect, async (req, res) => {
  try { return res.json({ success: true, ...(await service.markAllRead(req.user.id, { category: req.body && req.body.category })) }); } catch (e) { return fail(res, e); }
});

router.patch('/:id/read', protect, async (req, res) => {
  try {
    const r = await service.markRead(req.user.id, req.params.id);
    return res.json({ success: true, updated: r.updated > 0, unreadCount: r.unreadCount, message: r.updated ? 'Notification marked as read.' : 'Notification was already read or does not exist.' });
  } catch (e) { return fail(res, e); }
});

module.exports = router;
