// LocalHire - Booking Controller
// Manages customer-to-worker bookings with validation and PostgreSQL/Prisma persistence.
// Strictly validates customer, worker, pricing, and scheduling without fake persistence.

const prisma = require('../config/prisma');
const { notifyUser } = require('./notificationController');
const { stopBookingTracking, broadcastBookingStatus } = require('../trackingState');
const workingHours = require('../services/workingHours');
const paymentService = require('../services/paymentService');
const settlementService = require('../services/settlementService');
const trackingService = require('../services/trackingService');
const reviewService = require('../services/reviewService');
const { PaymentError } = require('../services/paymentCore');
const { getWorkerEligibility, NOT_VERIFIED_CODE, NOT_VERIFIED_MESSAGE } = require('../services/workerEligibility');

// Helper to resolve a user record from Prisma (PostgreSQL)
async function resolveUser(userId) {
  if (!userId) return null;

  try {
    let pUser = null;
    try {
      pUser = await prisma.user.findUnique({
        where: { id: String(userId) },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          avatarUrl: true,
          phone: true,
          isActive: true
        }
      });
    } catch (e) {
      pUser = null;
    }

    if (!pUser) return null;

    return {
      id: pUser.id,
      name: pUser.name,
      email: pUser.email,
      role: pUser.role === 'WORKER' ? 'Worker' : (pUser.role === 'ADMIN' ? 'Admin' : 'Customer'),
      avatarUrl: pUser.avatarUrl,
      phone: pUser.phone,
      source: 'prisma'
    };
  } catch (err) {
    console.warn('[Booking Controller] User lookup failed in Prisma:', err.message);
    return null;
  }
}

const BOOKING_STATUS_VALUES = [
  'REQUESTED',
  'CONFIRMED',
  'DISPATCHED',
  'IN_PROGRESS',
  'AWAITING_CUSTOMER_CONFIRMATION',
  'COMPLETED',
  'CANCELLED',
  'DISPUTED'
];

const evaluateBookingStatusTransition = ({
  currentUserId,
  actorRole,
  isCustomer,
  isWorker,
  isAdmin,
  currentStatus,
  requestedStatus,
  bookingCustomerId,
  bookingWorkerId,
  isEscrowHeld = false
}) => {
  if (!requestedStatus || !BOOKING_STATUS_VALUES.includes(requestedStatus)) {
    return {
      allowed: false,
      reason: `Invalid status. Valid values: ${BOOKING_STATUS_VALUES.join(', ')}`
    };
  }

  if (!currentStatus || currentStatus === requestedStatus) {
    return {
      allowed: false,
      reason: 'No status transition requested.'
    };
  }

  if (isAdmin) {
    const allowedFrom = {
      CONFIRMED: ['REQUESTED'],
      DISPATCHED: ['CONFIRMED'],
      IN_PROGRESS: ['CONFIRMED', 'DISPATCHED'],
      CANCELLED: ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS'],
      DISPUTED: ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS']
    };

    if (allowedFrom[requestedStatus] && allowedFrom[requestedStatus].includes(currentStatus)) {
      return {
        allowed: true,
        reason: 'Admin status transition permitted under explicit review workflow.',
        requiresCustomerConfirmation: false
      };
    }

    return {
      allowed: false,
      reason: 'Admin updates must follow a valid booking workflow.'
    };
  }

  if (isWorker) {
    if (requestedStatus === 'CONFIRMED' && currentStatus === 'REQUESTED') {
      return {
        allowed: true,
        reason: 'Worker accepted the booking request.'
      };
    }

    if (requestedStatus === 'CANCELLED' && currentStatus === 'REQUESTED') {
      return {
        allowed: true,
        reason: 'Worker rejected the booking request.'
      };
    }

    if (requestedStatus === 'IN_PROGRESS' && ['CONFIRMED', 'DISPATCHED'].includes(currentStatus)) {
      return {
        allowed: true,
        reason: 'Worker started the booked service.'
      };
    }

    // A worker cannot close a booking themselves: they finish the work and ask the customer to confirm it.
    // Only the customer's confirmation (which requires a captured payment) completes the booking.
    if (requestedStatus === 'AWAITING_CUSTOMER_CONFIRMATION' && currentStatus === 'IN_PROGRESS') {
      return {
        allowed: true,
        reason: 'Worker finished the service and requested customer confirmation.'
      };
    }

    if (requestedStatus === 'CANCELLED' && ['CONFIRMED', 'DISPATCHED'].includes(currentStatus)) {
      return {
        allowed: true,
        reason: 'Worker cancelled the confirmed booking.'
      };
    }

    if (requestedStatus === 'DISPATCHED' && currentStatus === 'CONFIRMED') {
      return {
        allowed: true,
        reason: 'Worker dispatched the booking.'
      };
    }

    return {
      allowed: false,
      reason: 'Workers are only allowed to accept, reject, cancel, dispatch, start, or request customer confirmation for a valid active booking.'
    };
  }

  if (isCustomer) {
    if (requestedStatus === 'CANCELLED') {
      const cancellableStatuses = ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS'];
      if (!cancellableStatuses.includes(currentStatus)) {
        return {
          allowed: false,
          reason: 'This booking cannot be cancelled in its current state.'
        };
      }

      return {
        allowed: true,
        reason: 'Customer cancellation is allowed.'
      };
    }

    if (requestedStatus === 'COMPLETED') {
      if (!['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'].includes(currentStatus)) {
        return {
          allowed: false,
          reason: 'Customer completion is only allowed while the booking is in progress.'
        };
      }

      if (bookingCustomerId && String(currentUserId) !== String(bookingCustomerId)) {
        return {
          allowed: false,
          reason: 'Only the booking owner can close this booking.'
        };
      }

      return {
        allowed: true,
        reason: 'Customer confirmed the completed service.'
      };
    }

    return {
      allowed: false,
      reason: 'Customers may only cancel or complete an active booking.'
    };
  }

  return {
    allowed: false,
    reason: 'User is not authorized to update this booking.'
  };
};

exports.evaluateBookingStatusTransition = evaluateBookingStatusTransition;

// @desc    Create a new booking (Customer hires worker)
// @route   POST /api/bookings
// @access  Private (Customer or Admin)
exports.createBooking = async (req, res) => {
  try {
    const { workerId, scheduledAt, timeSlot, agreedPrice, notes, serviceItemId, addressId } = req.body;
    const rawDescription = req.body.problemDescription !== undefined ? req.body.problemDescription : notes;
    const customerId = req.user.id || (req.user._id && req.user._id.toString());

    if (req.user.role !== 'Customer' && req.user.role !== 'Admin') {
      return res.status(403).json({
        success: false,
        message: 'Only Customer accounts can create bookings to hire workers'
      });
    }

    if (!workerId) {
      return res.status(400).json({ success: false, message: 'Worker ID is required' });
    }

    if (String(workerId) === String(customerId)) {
      return res.status(400).json({ success: false, message: 'You cannot book or hire yourself' });
    }

    if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== 'string') {
      return res.status(400).json({ success: false, message: 'Problem description must be text.' });
    }
    const problemDescription = typeof rawDescription === 'string' ? rawDescription.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() : '';
    if (problemDescription.length > 1000) {
      return res.status(400).json({ success: false, message: 'Problem description must be 1000 characters or fewer.' });
    }

    const priceNum = Number(agreedPrice);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return res.status(400).json({ success: false, message: 'Agreed price must be a valid positive number' });
    }

    if (!scheduledAt) {
      return res.status(400).json({ success: false, message: 'Scheduled date and time are required' });
    }

    const parsedDate = new Date(scheduledAt);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.getTime() < Date.now() - 60000) {
      return res.status(400).json({ success: false, message: 'Scheduled date must be a valid future date and time' });
    }

    const targetWorker = await resolveUser(workerId);
    if (!targetWorker) {
      return res.status(404).json({ success: false, message: 'Selected worker profile does not exist' });
    }

    if (targetWorker.role !== 'Worker') {
      return res.status(400).json({
        success: false,
        message: 'The selected account is not registered as a professional worker'
      });
    }

    // Backend gate: the requested start must fall inside the worker's published working hours (if any).
    const hoursCheck = await workingHours.validateForWorker(targetWorker.id, parsedDate);
    if (!hoursCheck.ok) {
      return res.status(400).json({ success: false, code: 'OUTSIDE_WORKING_HOURS', message: hoursCheck.reason });
    }

    // Backend gate: only verified, active workers can receive new bookings.
    const eligibility = await getWorkerEligibility(targetWorker.id);
    if (!eligibility.eligible) {
      return res.status(403).json({ success: false, code: NOT_VERIFIED_CODE, message: NOT_VERIFIED_MESSAGE });
    }

    if (serviceItemId) {
      const service = await prisma.serviceItem.findUnique({
        where: { id: String(serviceItemId) },
        include: {
          offeredBy: {
            include: {
              workerProfile: {
                select: { userId: true }
              }
            }
          }
        }
      });

      if (!service) {
        return res.status(404).json({ success: false, message: 'Selected service does not exist' });
      }

      const isOfferedByWorker = service.offeredBy.some((offering) => offering.workerProfile?.userId === targetWorker.id);
      if (!isOfferedByWorker) {
        return res.status(400).json({
          success: false,
          message: 'The selected service is not offered by the chosen worker'
        });
      }
    }

    const selectedAddressId = addressId || (await prisma.customerAddress.findFirst({
      where: { customerId, isDefault: true },
      select: { id: true }
    }))?.id;

    if (addressId) {
      const bookingAddress = await prisma.customerAddress.findFirst({
        where: { id: String(addressId), customerId }
      });

      if (!bookingAddress) {
        return res.status(400).json({
          success: false,
          message: 'Selected customer address does not belong to this account.'
        });
      }
    }

    const duplicateBooking = await prisma.booking.findFirst({
      where: {
        customerId,
        workerId: targetWorker.id,
        scheduledAt: parsedDate,
        status: { in: ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS'] }
      }
    });

    if (duplicateBooking) {
      return res.status(409).json({
        success: false,
        message: 'An active booking for this worker and time slot already exists.'
      });
    }

    const bookingNumber = `BK-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

    try {
      const newBooking = await prisma.$transaction(async (tx) => {
        const created = await tx.booking.create({
          data: {
            bookingNumber,
            customerId,
            workerId: targetWorker.id,
            serviceItemId: serviceItemId || null,
            addressId: selectedAddressId || null,
            agreedPrice: priceNum,
            problemDescription: problemDescription || null,
            scheduledAt: parsedDate,
            timeSlot: timeSlot || 'Flexible',
            status: 'REQUESTED',
            statusHistory: {
              create: {
                toStatus: 'REQUESTED',
                changedById: customerId,
                reason: notes || 'Booking request submitted by customer'
              }
            }
          },
          include: {
            customer: {
              select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
            },
            worker: {
              select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
            },
            address: true
          }
        });

        return created;
      });

      await notifyUser({
        userId: targetWorker.id,
        type: 'BOOKING_REQUEST',
        title: 'New booking request',
        bookingId: newBooking.id,
        message: `${newBooking.customer.name || 'A customer'} requested a booking for ${newBooking.scheduledAt.toLocaleDateString('en-IN', { dateStyle: 'medium' })}${newBooking.timeSlot && newBooking.timeSlot !== 'Flexible' ? ` (${newBooking.timeSlot})` : ''}.${problemDescription ? ` Job: "${problemDescription.length > 160 ? problemDescription.slice(0, 157) + '...' : problemDescription}"` : ''}`,
        linkUrl: `/bookings/${newBooking.id}`
      });
      await notifyUser({
        userId: newBooking.customerId,
        type: 'BOOKING_REQUEST',
        title: 'Booking request submitted',
        bookingId: newBooking.id,
        message: `Your request to ${newBooking.worker.name || 'the professional'} was sent for ${newBooking.scheduledAt.toLocaleDateString('en-IN', { dateStyle: 'medium' })}. You will be notified when they respond.`
      });

      return res.status(201).json({
        success: true,
        message: 'Booking successfully created and assigned to worker',
        booking: trackingService.sanitizeBooking(newBooking)
      });
    } catch (dbError) {
      console.error('[Booking Controller] Database persistence error:', dbError.message);
      return res.status(503).json({
        success: false,
        message: 'Database persistence unavailable: PostgreSQL is not connected or ready.',
        details: 'The booking could not be saved to the database. Please ensure PostgreSQL is configured and running.',
        error: dbError.message
      });
    }
  } catch (error) {
    console.error('[Booking Controller] createBooking error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error creating booking request',
      error: error.message
    });
  }
};

// @desc    Get bookings for the currently authenticated user (Customer or Worker)
// @route   GET /api/bookings/my
// @access  Private
exports.getMyBookings = async (req, res) => {
  try {
    const currentUserId = req.user.id || (req.user._id && req.user._id.toString());
    const isWorker = req.user.role === 'Worker';
    const isAdmin = req.user.role === 'Admin';

    let filter = {};
    if (isAdmin) {
      // Admin sees all
    } else if (isWorker) {
      // Workers strictly retrieve only bookings assigned to their worker ID
      filter.workerId = currentUserId;
    } else {
      // Customers retrieve bookings they requested
      filter.customerId = currentUserId;
    }

    try {
      const bookings = await prisma.booking.findMany({
        where: filter,
        include: {
          customer: {
            select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
          },
          worker: {
            select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
          },
          serviceItem: {
            select: { id: true, title: true, basePrice: true }
          },
          address: true,
          payment: { include: { settlement: true, refunds: { select: { status: true, kind: true } } } },
          ...reviewService.bookingReviewInclude
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      const role = req.user.role;
      return res.json({
        success: true,
        count: bookings.length,
        bookings: bookings.map((b) => trackingService.sanitizeBooking({ ...reviewService.withReviewState(b, role), payment: paymentService.serializeBookingPayment(b.payment, role) }))
      });
    } catch (dbError) {
      console.error('[Booking Controller] getMyBookings DB error:', dbError.message);
      return res.status(503).json({
        success: false,
        message: 'Database unavailable: PostgreSQL is not connected or ready.',
        bookings: [],
        error: dbError.message
      });
    }
  } catch (error) {
    console.error('[Booking Controller] getMyBookings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error retrieving bookings',
      error: error.message
    });
  }
};

// @desc    Get single booking by ID
// @route   GET /api/bookings/:id
// @access  Private
exports.getBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    const currentUserId = req.user.id || (req.user._id && req.user._id.toString());

    try {
      const booking = await prisma.booking.findUnique({
        where: { id },
        include: {
          customer: {
            select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
          },
          worker: {
            select: { id: true, name: true, email: true, phone: true, avatarUrl: true }
          },
          address: true,
          payment: { include: { settlement: true, refunds: { select: { status: true, kind: true } } } },
          ...reviewService.bookingReviewInclude,
          statusHistory: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      // Security: Only customer, assigned worker, or admin can inspect this booking
      if (
        booking.customerId !== currentUserId &&
        booking.workerId !== currentUserId &&
        req.user.role !== 'Admin'
      ) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this booking' });
      }

      return res.json({ success: true, booking: trackingService.sanitizeBooking({ ...reviewService.withReviewState(booking, req.user.role), payment: paymentService.serializeBookingPayment(booking.payment, req.user.role) }) });
    } catch (dbError) {
      return res.status(503).json({
        success: false,
        message: 'Database unavailable: PostgreSQL connection failed',
        error: dbError.message
      });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error retrieving booking', error: error.message });
  }
};

// Who gets told what when a booking changes state. Customer and worker each get a message written for them.
async function notifyStatusChange({ previousStatus, previousArrived, status, updated, actorId, refundOutcome }) {
  const workerName = updated.worker.name || 'The professional';
  const customerName = updated.customer.name || 'The customer';
  const base = { bookingId: updated.id };
  const toCustomer = (type, title, message) => notifyUser({ ...base, userId: updated.customerId, type, title, message });
  const toWorker = (type, title, message) => notifyUser({ ...base, userId: updated.workerId, type, title, message });

  if (status === 'CONFIRMED' && previousStatus === 'REQUESTED') {
    await toCustomer('BOOKING_CONFIRMED', 'Booking accepted', `${workerName} accepted your booking and confirmed the price of ₹${Number(updated.agreedPrice)}. You can pay now to secure it.`);
  } else if (status === 'DISPATCHED') {
    await toCustomer('WORKER_ON_THE_WAY', 'Your professional is on the way', `${workerName} has started the journey to you. You can follow the live location in My Jobs.`);
  } else if (status === 'IN_PROGRESS') {
    // arrival may already have been confirmed (and notified) separately
    if (previousArrived) await toCustomer('WORKER_ARRIVED', 'Service started', `${workerName} has started the service.`);
    else await toCustomer('WORKER_ARRIVED', 'Your professional has arrived', `${workerName} has arrived and started the service.`);
  } else if (status === 'AWAITING_CUSTOMER_CONFIRMATION') {
    await toCustomer('COMPLETION_REQUESTED', 'Please confirm the service', `${workerName} says the work is finished. Please review it and confirm completion, or report a problem.`);
  } else if (status === 'CANCELLED') {
    const byCustomer = actorId === updated.customerId;
    const byWorker = actorId === updated.workerId;
    const refundNote = refundOutcome && refundOutcome.refunded ? ' Your payment is being refunded.' : '';
    if (byWorker && previousStatus === 'REQUESTED') {
      await toCustomer('BOOKING_REJECTED', 'Booking request declined', `${workerName} could not take this booking. You can choose another professional.`);
    } else if (byCustomer) {
      await toWorker('BOOKING_CANCELLED', 'Booking cancelled by the customer', `${customerName} cancelled their booking.`);
    } else if (byWorker) {
      await toCustomer('BOOKING_CANCELLED', 'Booking cancelled by the professional', `${workerName} cancelled this booking.${refundNote}`);
    } else {
      await Promise.all([
        toCustomer('BOOKING_CANCELLED', 'Booking cancelled by LocalHire support', `This booking was cancelled by LocalHire support.${refundNote}`),
        toWorker('BOOKING_CANCELLED', 'Booking cancelled by LocalHire support', 'This booking was cancelled by LocalHire support.')
      ]);
    }
  }
}

// @desc    Worker proposes a new time for a booking that has not started yet
// @route   PATCH /api/bookings/:id/reschedule
// @access  Private (assigned Worker)
// The customer is notified and may cancel (a customer cancellation before the worker is on the way is refunded in full).
exports.rescheduleBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const workerId = req.user.id || (req.user._id && req.user._id.toString());
    const parsed = new Date(req.body && req.body.scheduledAt);
    const timeSlot = req.body && typeof req.body.timeSlot === 'string' ? req.body.timeSlot.trim().slice(0, 60) : '';
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 300) : '';

    const booking = await prisma.booking.findUnique({ where: { id }, include: { customer: { select: { id: true, name: true } }, worker: { select: { id: true, name: true } } } });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.workerId !== workerId) return res.status(403).json({ success: false, message: 'Only the assigned professional can reschedule this booking.' });
    if (!['REQUESTED', 'CONFIRMED'].includes(booking.status)) {
      return res.status(409).json({ success: false, message: 'A booking can only be rescheduled before the service journey starts.' });
    }
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() < Date.now() + 5 * 60000) {
      return res.status(400).json({ success: false, message: 'Choose a new date and time in the future.' });
    }
    if (parsed.getTime() === new Date(booking.scheduledAt).getTime()) {
      return res.status(400).json({ success: false, message: 'That is the time already booked.' });
    }
    if (reason.length < 3) return res.status(400).json({ success: false, message: 'Please give the customer a short reason for the change.' });
    const hours = await workingHours.validateForWorker(workerId, parsed);
    if (!hours.ok) return res.status(400).json({ success: false, code: 'OUTSIDE_WORKING_HOURS', message: hours.reason });

    const updated = await prisma.booking.update({
      where: { id },
      data: {
        scheduledAt: parsed, ...(timeSlot ? { timeSlot } : {}),
        statusHistory: { create: { fromStatus: booking.status, toStatus: booking.status, changedById: workerId, reason: `Rescheduled by the professional: ${reason}` } }
      }
    });
    const when = parsed.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    await notifyUser({
      userId: booking.customerId, type: 'BOOKING_RESCHEDULED', bookingId: id, title: 'Your booking was rescheduled',
      message: `${booking.worker.name || 'The professional'} moved your booking to ${when}${timeSlot ? ` (${timeSlot})` : ''}. Reason: ${reason}. If this does not suit you, you can cancel from My Jobs.`
    });
    return res.json({ success: true, message: 'Booking rescheduled. The customer has been notified.', booking: trackingService.sanitizeBooking(updated) });
  } catch (error) {
    console.error('[Booking Controller] rescheduleBooking error:', error);
    return res.status(500).json({ success: false, message: 'Server error rescheduling booking' });
  }
};

// ── Journey tracking API (participant-checked; see services/trackingService.js) ─────────────

const trackFail = (res, e) => {
  if (e instanceof trackingService.TrackError) return res.status(e.status).json({ success: false, message: e.message, code: e.code });
  console.error('[Booking Controller] tracking error:', e);
  return res.status(500).json({ success: false, message: 'Server error handling tracking.' });
};
const uidOf = (req) => String(req.user.id || (req.user._id && req.user._id.toString()));

// @route GET /api/bookings/:id/tracking  - customer or assigned worker only
exports.getBookingTracking = async (req, res) => {
  try {
    const r = await trackingService.getTracking({ bookingId: req.params.id, userId: uidOf(req) });
    return res.json({ success: true, role: r.role, tracking: r.tracking });
  } catch (e) { return trackFail(res, e); }
};

// @route POST /api/bookings/:id/location  - the assigned worker's fallback when the socket is not connected
exports.postBookingLocation = async (req, res) => {
  try {
    const b = req.body || {};
    const r = await trackingService.recordLocation({ bookingId: req.params.id, workerId: uidOf(req), latitude: b.latitude, longitude: b.longitude, accuracy: b.accuracy, timestamp: b.timestamp });
    return res.json({ success: true, accepted: r.accepted, throttled: Boolean(r.throttled) });
  } catch (e) { return trackFail(res, e); }
};

// @route POST /api/bookings/:id/arrive  - the assigned worker confirms arrival; live sharing ends
exports.arriveAtBooking = async (req, res) => {
  try {
    const r = await trackingService.markArrived({ bookingId: req.params.id, workerId: uidOf(req) });
    return res.json({ success: true, message: 'Arrival confirmed. Live location sharing has ended.', arrivedAt: r.arrivedAt });
  } catch (e) { return trackFail(res, e); }
};

// @desc    Update booking status (Accept, Start, Complete, Cancel)
// @route   PUT /api/bookings/:id/status
// @access  Private
exports.updateBookingStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const currentUserId = req.user.id || (req.user._id && req.user._id.toString());

    if (!status || !BOOKING_STATUS_VALUES.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Valid values: ${BOOKING_STATUS_VALUES.join(', ')}` });
    }

    try {
      const existing = await prisma.booking.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      const isCustomer = existing.customerId === currentUserId;
      const isWorker = existing.workerId === currentUserId;
      const isAdmin = req.user.role === 'Admin';

      if (!isCustomer && !isWorker && !isAdmin) {
        return res.status(403).json({ success: false, message: 'Not authorized to update this booking' });
      }

      const transition = evaluateBookingStatusTransition({
        currentUserId,
        actorRole: req.user.role,
        isCustomer,
        isWorker,
        isAdmin,
        currentStatus: existing.status,
        requestedStatus: status,
        bookingCustomerId: existing.customerId,
        bookingWorkerId: existing.workerId,
        isEscrowHeld: true
      });

      if (!transition.allowed) {
        const statusCode = transition.reason.includes('Only the booking owner') || transition.reason.includes('not authorized') ? 403 : 400;
        return res.status(statusCode).json({ success: false, message: transition.reason });
      }

      // Customer confirmation of completion is a payment-aware operation: it validates ownership, booking status,
      // payment capture, disputes and refunds, and only then makes the worker's earnings eligible for settlement.
      if (status === 'COMPLETED' && isCustomer && !isAdmin) {
        try {
          const out = await settlementService.confirmCompletion({ bookingId: id, user: { id: currentUserId, role: req.user.role } });
          stopBookingTracking(id, 'Booking completed; location sharing stopped.');
          broadcastBookingStatus(id, 'COMPLETED', { bookingId: id, status: 'COMPLETED', changedById: currentUserId });
          return res.json({ success: true, booking: out.booking, payoutDispatched: Boolean(out.payout && out.payout.dispatched) });
        } catch (error) {
          if (error instanceof PaymentError) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
          throw error;
        }
      }

      const updateData = {
        status,
        statusHistory: {
          create: {
            fromStatus: existing.status,
            toStatus: status,
            changedById: currentUserId,
            reason: notes || `Status updated to ${status}`
          }
        }
      };

      if (status === 'IN_PROGRESS' && !existing.startedAt) {
        updateData.startedAt = new Date();
      }

      // Journey bookkeeping. Starting the journey is the worker's explicit act (this status change); sharing their
      // position with the customer begins there and ends the moment it is no longer needed, erasing the stored point.
      if (status === 'DISPATCHED') {
        Object.assign(updateData, { journeyStartedAt: new Date(), arrivedAt: null, ...trackingService.CLEAR_TRACK });
      } else if (['IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'DISPUTED'].includes(status)) {
        Object.assign(updateData, trackingService.CLEAR_TRACK);
        if (status === 'IN_PROGRESS' && existing.status === 'DISPATCHED' && !existing.arrivedAt) updateData.arrivedAt = new Date(); // starting the service means they are there
      }

      // Accepting a request confirms the price. The worker may confirm a different final price; it must be sane.
      if (status === 'CONFIRMED' && existing.status === 'REQUESTED') {
        updateData.priceConfirmedAt = new Date();
        if (req.body.agreedPrice !== undefined && req.body.agreedPrice !== null && req.body.agreedPrice !== '') {
          const confirmed = Number(req.body.agreedPrice);
          const original = Number(existing.agreedPrice);
          if (!isWorker && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Only the professional can confirm the service price.' });
          }
          if (!Number.isFinite(confirmed) || confirmed < 50 || confirmed > 500000 || Math.round(confirmed * 100) !== confirmed * 100) {
            return res.status(400).json({ success: false, message: 'The confirmed price must be between ₹50 and ₹5,00,000 with at most two decimals.' });
          }
          if (confirmed !== original) {
            updateData.agreedPrice = confirmed;
            updateData.statusHistory.create.reason = `${notes || 'Booking accepted'} (price confirmed: ₹${confirmed}, requested ₹${original})`;
          }
        }
      }

      if (status === 'COMPLETED' && !existing.completedAt) {
        updateData.completedAt = new Date();
      }

      if (status === 'CANCELLED' && !existing.cancelledAt) {
        updateData.cancelledAt = new Date();
        updateData.cancellationReason = notes || 'Cancelled by user';
      }

      const updated = await prisma.$transaction(async (tx) => {
        return tx.booking.update({
          where: { id },
          data: updateData,
          include: {
            customer: { select: { id: true, name: true, email: true, avatarUrl: true } },
            worker: { select: { id: true, name: true, email: true, avatarUrl: true } }
          }
        });
      });

      broadcastBookingStatus(id, status, {
        bookingId: id,
        status,
        journeyStatus: trackingService.journeyStatus(updated),
        changedById: currentUserId,
        booking: {
          id: updated.id,
          status: updated.status,
          customerId: updated.customerId,
          workerId: updated.workerId,
          startedAt: updated.startedAt,
          completedAt: updated.completedAt,
          cancelledAt: updated.cancelledAt
        }
      });

      if (status === 'COMPLETED' || status === 'CANCELLED' || status === 'AWAITING_CUSTOMER_CONFIRMATION') {
        stopBookingTracking(id, `Booking ${status.toLowerCase()}; location sharing stopped.`);
      }

      // A cancelled booking returns any captured payment to the customer (full, or less a configured fee).
      let refundOutcome = null;
      if (status === 'CANCELLED') {
        try {
          const refund = await paymentService.handleBookingCancelled({ bookingId: id, previousStatus: existing.status, actor: { id: currentUserId, role: req.user.role } });
          refundOutcome = refund ? { refunded: true, amount: Number(refund.amount), status: refund.status } : null;
        } catch (refundError) {
          // The cancellation stands; the refund is retried by an admin/webhook. Never lose the cancel because the gateway hiccuped.
          console.error('[Booking] refund after cancellation failed for', id, refundError.message);
          refundOutcome = { error: true };
        }
      }

      // Real-time + stored notifications for everything that changed (never for a no-op).
      await notifyStatusChange({ previousStatus: existing.status, previousArrived: Boolean(existing.arrivedAt), status, updated, actorId: currentUserId, refundOutcome });

      return res.json({
        success: true,
        message: `Booking status updated to ${status}`,
        booking: trackingService.sanitizeBooking(updated),
        ...(refundOutcome ? { refund: refundOutcome } : {})
      });
    } catch (dbError) {
      return res.status(503).json({
        success: false,
        message: 'Database unavailable: PostgreSQL connection failed',
        error: dbError.message
      });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Server error updating booking status', error: error.message });
  }
};
