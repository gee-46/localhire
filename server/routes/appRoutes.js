const express = require('express');
const { createApplication, getApplicationsForJob, getWorkerApplications, acceptQuote } = require('../controllers/appController');
const { protect, authorize } = require('../middlewares/authMiddleware');

const router = express.Router();

router.post('/', protect, authorize('Worker', 'Admin'), createApplication);
// The complete applicant list is for the customer who posted the job and admins only (the controller also checks ownership).
// A professional reads their own quotes through GET /worker/me.
router.get('/job/:jobId', protect, authorize('Customer', 'Admin'), getApplicationsForJob);
router.get('/worker/me', protect, authorize('Worker', 'Admin'), getWorkerApplications);
router.put('/:id/accept', protect, authorize('Customer', 'Admin'), acceptQuote);

module.exports = router;
