const assert = require('node:assert/strict');
const bookingController = require('../controllers/bookingController');

const { evaluateBookingStatusTransition } = bookingController;

assert.equal(typeof evaluateBookingStatusTransition, 'function', 'Expected a status evaluation helper export');

const allowedWorkerAccept = evaluateBookingStatusTransition({
  currentUserId: 'worker-1',
  actorRole: 'Worker',
  isCustomer: false,
  isWorker: true,
  isAdmin: false,
  currentStatus: 'REQUESTED',
  requestedStatus: 'CONFIRMED',
  bookingCustomerId: 'customer-1',
  bookingWorkerId: 'worker-1',
  isEscrowHeld: false
});
assert.equal(allowedWorkerAccept.allowed, true, 'Worker should be allowed to accept a valid booking request');

const allowedWorkerReject = evaluateBookingStatusTransition({
  currentUserId: 'worker-1',
  actorRole: 'Worker',
  isCustomer: false,
  isWorker: true,
  isAdmin: false,
  currentStatus: 'REQUESTED',
  requestedStatus: 'CANCELLED',
  bookingCustomerId: 'customer-1',
  bookingWorkerId: 'worker-1',
  isEscrowHeld: false
});
assert.equal(allowedWorkerReject.allowed, true, 'Worker should be allowed to reject a pending booking request');

const allowedCustomerCompletion = evaluateBookingStatusTransition({
  currentUserId: 'customer-1',
  actorRole: 'Customer',
  isCustomer: true,
  isWorker: false,
  isAdmin: false,
  currentStatus: 'IN_PROGRESS',
  requestedStatus: 'COMPLETED',
  bookingCustomerId: 'customer-1',
  bookingWorkerId: 'worker-1',
  isEscrowHeld: true
});
assert.equal(allowedCustomerCompletion.allowed, true, 'Customer should be allowed to close an in-progress booking after the worker has finished');

const blockedWrongCustomer = evaluateBookingStatusTransition({
  currentUserId: 'customer-2',
  actorRole: 'Customer',
  isCustomer: false,
  isWorker: false,
  isAdmin: false,
  currentStatus: 'IN_PROGRESS',
  requestedStatus: 'COMPLETED',
  bookingCustomerId: 'customer-1',
  bookingWorkerId: 'worker-1',
  isEscrowHeld: true
});
assert.equal(blockedWrongCustomer.allowed, false, 'Wrong customer should not be allowed to mark a booking as completed');

const blockedDuplicateRelease = evaluateBookingStatusTransition({
  currentUserId: 'customer-1',
  actorRole: 'Customer',
  isCustomer: true,
  isWorker: false,
  isAdmin: false,
  currentStatus: 'COMPLETED',
  requestedStatus: 'COMPLETED',
  bookingCustomerId: 'customer-1',
  bookingWorkerId: 'worker-1',
  isEscrowHeld: true
});
assert.equal(blockedDuplicateRelease.allowed, false, 'Completed booking should reject repeated completion state attempts');

const blockedUnapprovedStatus = evaluateBookingStatusTransition({
  currentUserId: 'worker-1',
  actorRole: 'Worker',
  isCustomer: false,
  isWorker: true,
  isAdmin: false,
  currentStatus: 'IN_PROGRESS',
  requestedStatus: 'AWAITING_CUSTOMER_CONFIRMATION',
  bookingCustomerId: 'customer-1',
  bookingWorkerId: 'worker-1',
  isEscrowHeld: true
});
assert.equal(blockedUnapprovedStatus.allowed, true, 'A worker finishing the job must request customer confirmation instead of completing it');

const blockedWorkerComplete = evaluateBookingStatusTransition({
  currentUserId: 'worker-1', actorRole: 'Worker', isCustomer: false, isWorker: true, isAdmin: false,
  currentStatus: 'IN_PROGRESS', requestedStatus: 'COMPLETED', bookingCustomerId: 'customer-1', bookingWorkerId: 'worker-1', isEscrowHeld: true
});
assert.equal(blockedWorkerComplete.allowed, false, 'A worker must never be able to complete a booking (and so trigger earnings) on their own');

const blockedAdminComplete = evaluateBookingStatusTransition({
  currentUserId: 'admin-1', actorRole: 'Admin', isCustomer: false, isWorker: false, isAdmin: true,
  currentStatus: 'IN_PROGRESS', requestedStatus: 'COMPLETED', bookingCustomerId: 'customer-1', bookingWorkerId: 'worker-1', isEscrowHeld: true
});
assert.equal(blockedAdminComplete.allowed, false, 'Admins resolve through dispute resolution, not by force-completing a booking');

console.log('Stage 1 security checks passed');
