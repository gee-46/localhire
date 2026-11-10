// Reviews API. The rules live in services/reviewService.js; this file only maps HTTP to them.
const reviews = require('../services/reviewService');

const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e instanceof reviews.ReviewError) return res.status(e.status).json({ success: false, message: e.userMessage, code: e.code });
    console.error('[Review Controller]', e);
    return res.status(500).json({ success: false, message: 'Server error while processing the review.' });
  }
};

const ID = /^[0-9a-fA-F-]{8,64}$/;

// @desc    Review a completed booking (the booking's own customer, once, after completion)
// @route   POST /api/reviews   { bookingId, rating, comment }
// @access  Private (Customer)
exports.createReview = handle(async (req, res) => {
  const bookingId = req.body && req.body.bookingId;
  if (!bookingId || !ID.test(String(bookingId))) return res.status(400).json({ success: false, message: 'A booking is required to leave a review.', code: 'BOOKING_REQUIRED' });
  const { review, summary } = await reviews.createReview({ customerId: req.user.id, bookingId: String(bookingId), body: req.body });
  res.status(201).json({
    success: true,
    review: { id: review.id, rating: review.rating, comment: review.comment, status: 'PUBLISHED', createdAt: review.createdAt },
    summary, updatedRating: summary.average === null ? null : summary.average.toFixed(1)
  });
});

// @desc    Public reviews of a professional (published only) with the rating summary
// @route   GET /api/reviews/worker/:workerId?page=&limit=
// @access  Public
exports.getWorkerReviews = handle(async (req, res) => {
  if (!ID.test(String(req.params.workerId))) return res.json({ success: true, count: 0, total: 0, page: 1, pages: 1, reviews: [], summary: { count: 0, average: null, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } });
  res.json({ success: true, ...(await reviews.listPublic(req.params.workerId, req.query)) });
});

// @desc    The signed-in professional's own received reviews (published + removed placeholders) and report status
// @route   GET /api/reviews/received
// @access  Private (Worker)
exports.getReceived = handle(async (req, res) => {
  res.json({ success: true, ...(await reviews.listForWorker(req.user.id, req.query)) });
});

// @desc    A professional reports an abusive or fraudulent review about them
// @route   POST /api/reviews/:id/report   { reason, details }
// @access  Private (Worker)
exports.reportReview = handle(async (req, res) => {
  const report = await reviews.reportReview({ reviewId: req.params.id, reporterId: req.user.id, reason: req.body && req.body.reason, details: req.body && req.body.details });
  res.status(201).json({ success: true, message: 'Thank you. A LocalHire moderator will look at this review. It stays visible until a decision is made.', report });
});
