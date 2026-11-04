// Single source of truth for "may customers discover and book this worker?".
// A worker is bookable only when their account is active AND their identity verification was
// approved (WorkerProfile.verificationStatus === 'VERIFIED', which is only ever set by the admin
// document-review workflow). Pending, rejected, resubmission-required and unverified workers are not.
const prisma = require('../config/prisma');

const NOT_VERIFIED_CODE = 'WORKER_NOT_VERIFIED';
const NOT_VERIFIED_MESSAGE = 'This professional has not completed identity verification yet and cannot be booked.';
const SELF_NOT_VERIFIED_MESSAGE = 'Complete identity verification from your Worker Hub before you can take new bookings or send quotes.';

// Prisma filter fragment for WorkerProfile queries
const VERIFIED_PROFILE = { verificationStatus: 'VERIFIED' };

// Returns { eligible, reason } for a worker's user id. Existing bookings are never touched by this.
const getWorkerEligibility = async (workerUserId) => {
  if (!workerUserId) return { eligible: false, reason: 'NO_WORKER' };
  const profile = await prisma.workerProfile.findUnique({
    where: { userId: String(workerUserId) },
    select: { verificationStatus: true, user: { select: { isActive: true, role: true } } }
  });
  if (!profile) return { eligible: false, reason: 'NO_PROFILE' };
  if (profile.user && (profile.user.role !== 'WORKER' || profile.user.isActive === false)) return { eligible: false, reason: 'INACTIVE' };
  if (profile.verificationStatus !== 'VERIFIED') return { eligible: false, reason: profile.verificationStatus || 'UNVERIFIED' };
  return { eligible: true, reason: null };
};

module.exports = { NOT_VERIFIED_CODE, NOT_VERIFIED_MESSAGE, SELF_NOT_VERIFIED_MESSAGE, VERIFIED_PROFILE, getWorkerEligibility };
