// LocalHire - Booking Routes
// Routes for creating bookings, fetching assigned bookings, and updating status.
// Strictly protected with authentication and role-based access control.

const express = require('express');
const {
  createBooking,
  rescheduleBooking,
  getBookingTracking,
  postBookingLocation,
  arriveAtBooking,
  getMyBookings,
  getBookingById,
  updateBookingStatus
} = require('../controllers/bookingController');
const { protect, authorize } = require('../middlewares/authMiddleware');

const rateLimit = require('express-rate-limit');
const router = express.Router();

// Location updates arrive every few seconds from a working worker; this only stops abuse.
const trackingLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.TRACKING_RATE_LIMIT_MAX) || 60, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many location updates. Slow down.' } });

// Customer or Admin can initiate a booking
router.post('/', protect, authorize('Customer', 'Admin'), createBooking);

// Retrieve current authenticated user's bookings (Customer sees requested, Worker sees assigned)
router.get('/my', protect, getMyBookings);

// Specific booking details (ownership validated on server)
router.get('/:id', protect, getBookingById);

// Update status (e.g. Worker confirms/starts/completes, Customer cancels)
router.put('/:id/status', protect, updateBookingStatus);
router.patch('/:id/reschedule', protect, authorize('Worker'), rescheduleBooking);
router.get('/:id/tracking', protect, getBookingTracking);
router.post('/:id/location', trackingLimiter, protect, authorize('Worker'), postBookingLocation);
router.post('/:id/arrive', protect, authorize('Worker'), arriveAtBooking);

module.exports = router;
