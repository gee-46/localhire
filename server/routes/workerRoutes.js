const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  getOnboarding, getStatus, saveStep, uploadDocument, deleteDocument, submitOnboarding, getDashboard,
  getPortfolio, addPortfolioItem, deletePortfolioItem
} = require('../controllers/workerController');
const { documentUpload, handleDocumentUploadError } = require('../middlewares/documentUpload');
const { upload, handleMulterError } = require('../middlewares/uploadMiddleware');
const payc = require('../controllers/paymentController');
const { protect, authorize } = require('../middlewares/authMiddleware');

const router = express.Router();

// Uploads are the expensive/abusable path: cap them per IP.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many uploads. Please try again in a few minutes.' }
});

router.use(protect);
router.use(authorize('Worker'));

router.get('/status', getStatus);
router.get('/dashboard', getDashboard);
router.get('/onboarding', getOnboarding);
router.put('/onboarding/step/:step', saveStep);
router.post('/onboarding/documents', uploadLimiter, documentUpload.single('file'), handleDocumentUploadError, uploadDocument);
router.delete('/onboarding/documents/:id', deleteDocument);
router.post('/onboarding/submit', submitOnboarding);

// Earnings and payout account: the worker's own side of the money only
router.get('/earnings', payc.workerEarnings);
router.get('/payout-account', payc.payoutAccountStatus);
router.post('/payout-account', payc.payoutAccountStart);
router.post('/payout-account/sync', payc.payoutAccountSync);

router.get('/portfolio', getPortfolio);
router.post('/portfolio', uploadLimiter, upload.single('photo'), handleMulterError, addPortfolioItem);
router.delete('/portfolio/:id', deletePortfolioItem);

module.exports = router;
