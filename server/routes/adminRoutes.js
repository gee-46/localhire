const express = require('express');
const router = express.Router();
const {
  getMetrics,
  getAllUsers,
  verifyUser,
  deleteUser,
  getAllJobs,
  flagJob,
  deleteJob
} = require('../controllers/adminController');
const wv = require('../controllers/workerVerificationAdminController');
const pay = require('../controllers/paymentController');
const ac = require('../controllers/adminConsoleController');
const multer = require('multer');
const { protect, authorize } = require('../middlewares/authMiddleware');

// Protect all admin routes with authentication and Admin role check
router.use(protect);
router.use(authorize('Admin'));

// Category icons: small images held in memory, validated by their bytes in services/publicImages.js
const iconUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const handleUploadError = (err, req, res, next) => {
  if (err) return res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'The image is larger than 2 MB.' : 'The upload could not be read.' });
  return next();
};

router.get('/metrics', getMetrics);

// ── Admin console (Phase 7) ──
router.get('/dashboard', ac.dashboard);
router.get('/analytics', ac.analytics);
router.get('/finance/summary', ac.financeSummary);
router.get('/finance/owed-workers', ac.financeOwed);
router.get('/finance/settlements', ac.financeSettlements);
router.get('/workers', ac.listWorkers);
router.get('/workers/:id', ac.getWorker);
router.post('/workers/:id/suspend', ac.suspendWorker);
router.post('/workers/:id/reactivate', ac.reactivateWorker);
router.get('/reviews', ac.listReviews);
router.get('/reviews/:id', ac.getReview);
router.post('/reviews/:id/hide', ac.hideReview);
router.post('/reviews/:id/restore', ac.restoreReview);
router.post('/reviews/:id/dismiss-reports', ac.dismissReviewReports);
router.get('/customers', ac.listCustomers);
router.get('/customers/:id', ac.getCustomer);
router.post('/customers/:id/suspend', ac.suspendCustomer);
router.post('/customers/:id/reactivate', ac.reactivateCustomer);
router.get('/bookings', ac.listBookings);
router.get('/bookings/:id', ac.getBooking);
router.get('/categories', ac.listCategories);
router.post('/categories', ac.createCategory);
router.patch('/categories/:id', ac.updateCategory);
router.post('/categories/:id/icon', iconUpload.single('icon'), handleUploadError, ac.uploadCategoryIcon);
router.delete('/categories/:id', ac.deleteCategory);
router.get('/audit-logs', ac.auditLogs);

router.get('/users', getAllUsers);
router.patch('/users/:id/verify', verifyUser);
router.delete('/users/:id', deleteUser);

// Worker onboarding review (private documents are only reachable through these admin-only routes)
router.get('/worker-verifications', wv.listVerifications);
router.get('/worker-verifications/:userId', wv.getVerification);
router.get('/worker-verifications/:userId/documents/:docId/url', wv.getDocumentUrl);
router.patch('/worker-verifications/:userId/documents/:docId', wv.reviewDocument);
router.post('/worker-verifications/:userId/start-review', wv.startReview);
router.post('/worker-verifications/:userId/approve', wv.approve);
router.post('/worker-verifications/:userId/reject', wv.reject);
router.post('/worker-verifications/:userId/request-resubmission', wv.requestResubmission);

// Payments, refunds, disputes and payouts
router.get('/payments', pay.adminList);
router.get('/payments/payout-status', pay.adminPayoutStatus);
router.post('/payments/:paymentId/refund', pay.adminRefund);
router.post('/payments/:paymentId/resolve-dispute', pay.adminResolveDispute);
router.post('/settlements/:settlementId/retry', pay.adminRetryPayout);

router.get('/jobs', getAllJobs);
router.patch('/jobs/:id/flag', flagJob);
router.delete('/jobs/:id', deleteJob);

module.exports = router;
