// Reviews and trust. One place for the rules, so the API, the booking payload and the admin console agree.
//
// States of a review (stored in Review.status):
//   PUBLISHED  visible on the professional's profile and counted in their public rating.
//   HIDDEN     removed from public view and from every rating; the record, its reports and its moderation history are kept.
// "Reported" is not stored: it is a PUBLISHED review with at least one OPEN ReviewReport (see stateOf()).
// A submitted review can never be edited or deleted by anyone (a database trigger enforces this); it can only be
// hidden or restored by an administrator, always with a written reason.
//
// Public ratings: WorkerProfile.rating / reviewsCount are a cached aggregate of PUBLISHED reviews, rewritten by
// recomputeWorkerRating() inside the same transaction as every change that could alter it.
const prisma = require('../config/prisma');
const { notify } = require('./notificationService');

const LIMITS = { ratingMin: 1, ratingMax: 5, commentMin: 10, commentMax: 1000, reasonMin: 5, reasonMax: 500, reportDetailsMax: 1000 };
const REPORT_REASONS = ['ABUSIVE', 'FAKE_OR_FRAUDULENT', 'NOT_MY_CUSTOMER', 'PRIVATE_INFORMATION', 'OTHER'];
const OPEN_DISPUTE = ['OPEN', 'UNDER_REVIEW'];

class ReviewError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.userMessage = message; this.code = code; }
}
const fail = (status, message, code) => { throw new ReviewError(status, message, code); };

// ── Input handling ───────────────────────────────────────────────────────────
// Free text is stored as plain text: markup, control characters and runaway whitespace are removed. Output is also
// HTML-escaped by every client, so this is defence in depth, not the only protection.
const cleanText = (value) => String(typeof value === 'string' ? value : '') // objects, arrays and numbers are not text
  .normalize('NFC')
  .replace(/<[^>]*>/g, ' ')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
  .replace(/\r\n?/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const parseRating = (value) => {
  if (typeof value === 'string' && !/^[1-5]$/.test(value.trim())) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(n) && n >= LIMITS.ratingMin && n <= LIMITS.ratingMax ? n : null;
};

const validateReviewInput = (body) => {
  const rating = parseRating(body && body.rating);
  if (rating === null) fail(400, 'Choose a rating from 1 to 5 stars.', 'BAD_RATING');
  const comment = cleanText(body && body.comment);
  if (comment.length < LIMITS.commentMin) fail(400, `Please write at least ${LIMITS.commentMin} characters about your experience.`, 'COMMENT_TOO_SHORT');
  if (comment.length > LIMITS.commentMax) fail(400, `Your review is too long. Keep it under ${LIMITS.commentMax} characters.`, 'COMMENT_TOO_LONG');
  if (!/[\p{L}\p{N}]{3,}/u.test(comment)) fail(400, 'Please describe your experience in words.', 'COMMENT_EMPTY');
  return { rating, comment };
};

const validateReason = (value, label = 'reason') => {
  const reason = cleanText(value);
  if (reason.length < LIMITS.reasonMin) fail(400, `A ${label} of at least ${LIMITS.reasonMin} characters is required.`, 'REASON_REQUIRED');
  if (reason.length > LIMITS.reasonMax) fail(400, `The ${label} must be under ${LIMITS.reasonMax} characters.`, 'REASON_TOO_LONG');
  return reason;
};

// ── Presentation ─────────────────────────────────────────────────────────────
// Public reviews show a first name and last initial only: no id, e-mail, phone, address or photo.
const reviewerLabel = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Customer';
  const first = parts[0].slice(0, 24);
  return parts.length > 1 ? `${first} ${Array.from(parts[parts.length - 1])[0].toUpperCase()}.` : first;
};

const stateOf = (review, openReports = 0) => (review.status === 'HIDDEN' ? 'HIDDEN' : openReports > 0 ? 'REPORTED' : 'PUBLISHED');

const publicReview = (r) => ({ id: r.id, rating: r.rating, comment: r.comment, reviewerName: reviewerLabel(r.customer && r.customer.name), createdAt: r.createdAt, verifiedBooking: true });

// ── Aggregation ──────────────────────────────────────────────────────────────
const round1 = (n) => Math.round(Number(n) * 10) / 10;

// Count, average and 1..5 distribution of PUBLISHED reviews only. Average is null when there are none.
const summaryFor = async (workerId, db = prisma) => {
  const rows = await db.review.groupBy({ by: ['rating'], where: { workerId: String(workerId), status: 'PUBLISHED' }, _count: { _all: true } });
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0; let sum = 0;
  rows.forEach((r) => { distribution[r.rating] = r._count._all; count += r._count._all; sum += r.rating * r._count._all; });
  return { count, average: count ? round1(sum / count) : null, distribution };
};

// Rewrites the cached public rating from the PUBLISHED reviews. Pass a transaction client to keep it atomic.
const recomputeWorkerRating = async (workerId, db = prisma) => {
  const agg = await db.review.aggregate({ where: { workerId: String(workerId), status: 'PUBLISHED' }, _avg: { rating: true }, _count: { _all: true } });
  const count = agg._count._all;
  const rating = count ? Math.round(Number(agg._avg.rating) * 100) / 100 : 0;
  await db.workerProfile.updateMany({ where: { userId: String(workerId) }, data: { rating, reviewsCount: count } });
  return { count, rating: count ? rating : null };
};

// ── Eligibility ──────────────────────────────────────────────────────────────
// canReview is decided only from stored facts about the booking. `review` is the caller's own review, if any.
const NOT_ELIGIBLE = {
  NOT_OWNER: 'Only the customer who made this booking can review it.',
  NOT_COMPLETED: 'You can review a booking once the job is completed.',
  CANCELLED: 'A cancelled booking cannot be reviewed.',
  DISPUTED: 'A booking with an open dispute cannot be reviewed until it is resolved.',
  ALREADY_REVIEWED: 'You have already reviewed this booking.'
};
const eligibility = (booking, customerId, existingReview, openDisputes = 0) => {
  if (!booking || String(booking.customerId) !== String(customerId)) return { canReview: false, code: 'NOT_OWNER', reason: NOT_ELIGIBLE.NOT_OWNER };
  if (booking.status === 'CANCELLED') return { canReview: false, code: 'CANCELLED', reason: NOT_ELIGIBLE.CANCELLED };
  if (booking.status === 'DISPUTED' || openDisputes > 0) return { canReview: false, code: 'DISPUTED', reason: NOT_ELIGIBLE.DISPUTED };
  if (booking.status !== 'COMPLETED') return { canReview: false, code: 'NOT_COMPLETED', reason: NOT_ELIGIBLE.NOT_COMPLETED };
  if (existingReview) return { canReview: false, code: 'ALREADY_REVIEWED', reason: NOT_ELIGIBLE.ALREADY_REVIEWED };
  return { canReview: true, code: null, reason: null };
};

// What a booking payload shows about reviews. Customers see their own review and whether they may write one;
// everyone else gets nothing (professionals read reviews through their own endpoint).
const REVIEW_SELECT = { id: true, rating: true, comment: true, status: true, createdAt: true };
const bookingReviewInclude = { review: { select: REVIEW_SELECT }, disputes: { where: { status: { in: OPEN_DISPUTE } }, select: { id: true } } };
const withReviewState = (booking, role) => {
  const { review, disputes, ...rest } = booking;
  if (role !== 'Customer') return rest;
  const e = eligibility(booking, booking.customerId, review, (disputes || []).length);
  return {
    ...rest,
    reviewState: {
      canReview: e.canReview, reason: e.canReview ? null : e.reason, code: e.code,
      review: review ? { id: review.id, rating: review.rating, comment: review.comment, status: review.status === 'HIDDEN' ? 'HIDDEN' : 'PUBLISHED', createdAt: review.createdAt } : null
    }
  };
};

// ── Writing a review ─────────────────────────────────────────────────────────
const createReview = async ({ customerId, bookingId, body }) => {
  const { rating, comment } = validateReviewInput(body);
  if (!bookingId || typeof bookingId !== 'string' || bookingId.length > 64) fail(400, 'A booking is required.', 'BOOKING_REQUIRED');
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: { review: { select: { id: true } }, disputes: { where: { status: { in: OPEN_DISPUTE } }, select: { id: true } }, customer: { select: { name: true } } } });
  // A booking that is not yours looks exactly like one that does not exist.
  if (!booking || booking.customerId !== customerId) fail(404, 'Booking not found.', 'NOT_FOUND');
  const e = eligibility(booking, customerId, booking.review, booking.disputes.length);
  if (!e.canReview) fail(e.code === 'ALREADY_REVIEWED' ? 409 : 422, e.reason, e.code);

  let review;
  try {
    review = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({ data: { bookingId: booking.id, customerId, workerId: booking.workerId, rating, comment, isVerified: true } });
      await recomputeWorkerRating(booking.workerId, tx);
      return created;
    });
  } catch (err) {
    // Two submissions racing for the same booking: the unique index lets exactly one through.
    if (err && err.code === 'P2002') fail(409, NOT_ELIGIBLE.ALREADY_REVIEWED, 'ALREADY_REVIEWED');
    if (err && /review_booking_/.test(String(err.message))) fail(422, NOT_ELIGIBLE.NOT_COMPLETED, 'NOT_COMPLETED');
    throw err;
  }
  const snippet = comment.length > 120 ? `${comment.slice(0, 117)}...` : comment;
  await notify({
    userId: booking.workerId, type: 'REVIEW_SUBMITTED', bookingId: booking.id,
    title: `New ${rating}-star review`, message: `${reviewerLabel(booking.customer && booking.customer.name)} rated your work ${rating} out of 5: "${snippet}"`
  });
  return { review, summary: await summaryFor(booking.workerId) };
};

// ── Public and worker reads ──────────────────────────────────────────────────
const paging = (q, def = 10, max = 30) => {
  const limit = Math.min(max, Math.max(1, parseInt(q && q.limit, 10) || def));
  const page = Math.max(1, parseInt(q && q.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
};

const listPublic = async (workerId, query) => {
  const { limit, page, skip } = paging(query);
  const where = { workerId: String(workerId), status: 'PUBLISHED' };
  const [rows, total, summary] = await Promise.all([
    prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: limit, include: { customer: { select: { name: true } } } }),
    prisma.review.count({ where }),
    summaryFor(workerId)
  ]);
  return { reviews: rows.map(publicReview), count: total, total, page, pages: Math.max(1, Math.ceil(total / limit)), summary };
};

// The professional's own view: published reviews with the state of their own report, plus a placeholder for reviews a
// moderator removed (the text of a removed review is not shown, and the customer's name never is).
const listForWorker = async (workerId, query) => {
  const { limit, page, skip } = paging(query, 10, 30);
  const where = { workerId: String(workerId) };
  const [rows, total, summary, openReports] = await Promise.all([
    prisma.review.findMany({
      where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: limit,
      include: { customer: { select: { name: true } }, reports: { where: { reporterId: String(workerId) }, select: { id: true, status: true, reason: true, createdAt: true } } }
    }),
    prisma.review.count({ where }),
    summaryFor(workerId),
    prisma.reviewReport.count({ where: { reporterId: String(workerId), status: 'OPEN' } })
  ]);
  return {
    reviews: rows.map((r) => {
      const report = r.reports[0] || null;
      const base = { id: r.id, createdAt: r.createdAt, state: r.status === 'HIDDEN' ? 'HIDDEN' : report && report.status === 'OPEN' ? 'REPORTED' : 'PUBLISHED' };
      return r.status === 'HIDDEN'
        ? { ...base, hiddenNote: 'LocalHire removed this review after moderation. It no longer counts towards your rating.' }
        : { ...base, rating: r.rating, comment: r.comment, reviewerName: reviewerLabel(r.customer && r.customer.name), report: report ? { status: report.status, reason: report.reason, createdAt: report.createdAt } : null, canReport: !report };
    }),
    total, page, pages: Math.max(1, Math.ceil(total / limit)), summary, openReports
  };
};

// ── Reporting (professional -> moderators) ───────────────────────────────────
const reportReview = async ({ reviewId, reporterId, reason, details }) => {
  if (!REPORT_REASONS.includes(String(reason))) fail(400, 'Choose why you are reporting this review.', 'BAD_REASON');
  const text = cleanText(details);
  if (text.length > LIMITS.reportDetailsMax) fail(400, `Details must be under ${LIMITS.reportDetailsMax} characters.`, 'DETAILS_TOO_LONG');
  if (reason === 'OTHER' && text.length < LIMITS.reasonMin) fail(400, 'Please explain the problem so a moderator can assess it.', 'DETAILS_REQUIRED');
  const review = await prisma.review.findUnique({ where: { id: String(reviewId || '') }, select: { id: true, workerId: true, status: true } });
  // Reviews about other professionals look like they do not exist.
  if (!review || review.workerId !== reporterId) fail(404, 'Review not found.', 'NOT_FOUND');
  if (review.status === 'HIDDEN') fail(409, 'This review has already been removed by a moderator.', 'ALREADY_HIDDEN');
  try {
    const report = await prisma.reviewReport.create({ data: { reviewId: review.id, reporterId, reason, details: text || null } });
    return { id: report.id, status: report.status, reason: report.reason, createdAt: report.createdAt };
  } catch (err) {
    if (err && err.code === 'P2002') fail(409, 'You have already reported this review. A moderator will look at it.', 'ALREADY_REPORTED');
    throw err;
  }
};

// ── Moderation (admin) ───────────────────────────────────────────────────────
// Every action: validates a reason, runs in one transaction with the history row, and leaves the review's content
// untouched. The caller writes the audit log entry.
const moderate = async ({ action, reviewId, actor, reason: rawReason }) => {
  const reason = validateReason(rawReason);
  const result = await prisma.$transaction(async (tx) => {
    // Serialise concurrent moderators on the same review.
    await tx.$queryRaw`SELECT "id" FROM "Review" WHERE "id" = ${String(reviewId)} FOR UPDATE`;
    const review = await tx.review.findUnique({ where: { id: String(reviewId) } });
    if (!review) fail(404, 'Review not found.', 'NOT_FOUND');
    const openReports = await tx.reviewReport.findMany({ where: { reviewId: review.id, status: 'OPEN' }, select: { id: true, reporterId: true } });
    const now = new Date();
    const event = async (a) => tx.reviewModerationEvent.create({ data: { reviewId: review.id, action: a, actorId: actor.id, reason } });
    const resolveReports = (status, note) => tx.reviewReport.updateMany({ where: { reviewId: review.id, status: 'OPEN' }, data: { status, resolvedAt: now, resolvedById: actor.id, resolutionNote: note } });
    let resolved = [];

    if (action === 'hide') {
      if (review.status === 'HIDDEN') fail(409, 'This review is already hidden.', 'ALREADY_HIDDEN');
      await tx.review.update({ where: { id: review.id }, data: { status: 'HIDDEN', hiddenAt: now, hiddenReason: reason, hiddenById: actor.id } });
      await event('HIDDEN');
      if (openReports.length) { await resolveReports('UPHELD', reason); await event('REPORT_UPHELD'); resolved = openReports; }
    } else if (action === 'restore') {
      if (review.status !== 'HIDDEN') fail(409, 'This review is not hidden.', 'NOT_HIDDEN');
      await tx.review.update({ where: { id: review.id }, data: { status: 'PUBLISHED', hiddenAt: null, hiddenReason: null, hiddenById: null } });
      await event('RESTORED');
    } else if (action === 'dismiss') {
      if (!openReports.length) fail(409, 'There are no open reports on this review.', 'NO_OPEN_REPORTS');
      await resolveReports('DISMISSED', reason); await event('REPORT_DISMISSED'); resolved = openReports;
    } else fail(400, 'Unknown moderation action.', 'BAD_ACTION');

    const rating = await recomputeWorkerRating(review.workerId, tx);
    return { review, rating, resolved, workerId: review.workerId };
  }, { timeout: 15000 });

  // Tell the professionals whose reports were decided (never blocks or fails the moderation).
  await Promise.all(result.resolved.map((r) => notify({
    userId: r.reporterId, type: 'SYSTEM_ALERT',
    title: action === 'hide' ? 'Review removed after your report' : 'Your review report was reviewed',
    message: action === 'hide' ? 'A moderator removed the review you reported. It no longer counts towards your rating.' : 'A moderator reviewed your report and the review stays published. Reason: ' + reason.slice(0, 200)
  })));
  return { workerId: result.workerId, rating: result.rating, reportsResolved: result.resolved.length };
};

module.exports = {
  LIMITS, REPORT_REASONS, ReviewError, cleanText, validateReviewInput, validateReason, reviewerLabel, stateOf, publicReview,
  summaryFor, recomputeWorkerRating, eligibility, bookingReviewInclude, withReviewState, createReview,
  listPublic, listForWorker, reportReview, moderate, paging
};
