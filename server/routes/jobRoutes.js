const express = require('express');
const { getJobs, getJobById, createJob, updateJobStatus } = require('../controllers/jobController');
const { protect, authorize, optionalAuth } = require('../middlewares/authMiddleware');

const router = express.Router();

// Public job board. The caller is identified only so the poster (and admins) can see who posted a job: nobody else ever does.
router.get('/', optionalAuth, getJobs);
router.get('/:id', optionalAuth, getJobById);
router.post('/', protect, authorize('Customer', 'Admin'), createJob);
router.put('/:id/status', protect, updateJobStatus);

module.exports = router;
