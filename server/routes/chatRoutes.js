const express = require('express');
const c = require('../controllers/chatController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.use(protect);

// Booking-scoped (preferred)
router.get('/conversations', c.getConversations);
router.get('/unread-count', c.getUnreadCount);
router.get('/bookings/:bookingId', c.getBookingChat);
router.get('/bookings/:bookingId/messages', c.getBookingMessages);
router.post('/bookings/:bookingId/messages', c.postBookingMessage);
router.post('/bookings/:bookingId/read', c.markBookingRead);

// Legacy user-pair routes (resolve to the latest real booking between the two users)
router.patch('/conversations/:id/read', c.markAsRead);
router.patch('/read/:id', c.markAsRead);
router.get('/user/:id', c.getChatUser);
router.get('/messages/:otherUserId', c.getMessages);
router.post('/messages', c.sendMessage);

module.exports = router;
