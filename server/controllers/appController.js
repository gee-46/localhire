const prisma = require('../config/prisma');
const { notifyUser } = require('./notificationController');
const { getWorkerEligibility, NOT_VERIFIED_CODE, NOT_VERIFIED_MESSAGE, SELF_NOT_VERIFIED_MESSAGE } = require('../services/workerEligibility');

const statusMap = {
  PENDING: 'Pending',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn'
};

const formatApplication = (application) => ({
  id: application.id,
  jobId: application.jobId,
  workerId: application.workerId,
  workerName: application.worker?.name || 'Unknown Worker',
  workerAvatar: application.worker?.avatarUrl || '',
  quote: Number(application.quoteAmount || 0),
  message: application.coverMessage || '',
  status: statusMap[application.status] || 'Pending'
});

// @desc    Submit a quote/application for a job
// @route   POST /api/applications
// @access  Private (Worker)
exports.createApplication = async (req, res) => {
  try {
    const jobId = req.body.jobId || req.body.job;
    const quote = Number(req.body.quote ?? 0);
    const message = req.body.message || '';

    if (!jobId) {
      return res.status(400).json({ success: false, message: 'Job ID is required' });
    }

    if (!Number.isFinite(quote) || quote <= 0) {
      return res.status(400).json({ success: false, message: 'Quote must be a valid positive number' });
    }

    // Quoting leads to hiring, so it needs the same verification as a booking. (Admins acting on behalf are exempt.)
    if (req.user.role === 'Worker') {
      const eligibility = await getWorkerEligibility(req.user.id);
      if (!eligibility.eligible) {
        return res.status(403).json({ success: false, code: NOT_VERIFIED_CODE, message: SELF_NOT_VERIFIED_MESSAGE });
      }
    }

    const jobExists = await prisma.jobPost.findUnique({ where: { id: String(jobId) } });
    if (!jobExists) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    const existing = await prisma.jobApplication.findFirst({
      where: {
        jobId: String(jobId),
        workerId: req.user.id
      }
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'You have already submitted a quote for this job' });
    }

    const app = await prisma.jobApplication.create({
      data: {
        jobId: String(jobId),
        workerId: req.user.id,
        quoteAmount: Number.isFinite(quote) ? quote : 0,
        coverMessage: String(message),
        status: 'PENDING'
      },
      include: {
        worker: { select: { id: true, name: true, avatarUrl: true } }
      }
    });

    res.status(201).json({
      success: true,
      application: formatApplication(app)
    });
  } catch (error) {
    console.error('[Application Controller] createApplication error:', error);
    res.status(500).json({
      success: false,
      message: error && error.message ? error.message : 'Server error submitting application'
    });
  }
};

// @desc    Get applications for a job (the posting customer, or an admin)
// @route   GET /api/applications/job/:jobId
// @access  Private (Customer who owns the job, Admin)
// A job that does not exist and a job that belongs to someone else get the SAME answer, so this endpoint cannot be used
// to discover which job ids exist or who owns them.
const JOB_NOT_FOUND = { success: false, message: 'Job not found' };

exports.getApplicationsForJob = async (req, res) => {
  try {
    const job = await prisma.jobPost.findUnique({ where: { id: String(req.params.jobId) }, select: { customerId: true } });
    if (!job || (req.user.role !== 'Admin' && job.customerId !== req.user.id)) {
      return res.status(404).json(JOB_NOT_FOUND);
    }

    const apps = await prisma.jobApplication.findMany({
      where: { jobId: req.params.jobId },
      include: {
        worker: { select: { id: true, name: true, avatarUrl: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = apps.map(formatApplication);
    res.json({ success: true, count: formatted.length, applications: formatted });
  } catch (error) {
    console.error('[Application Controller] getApplicationsForJob error:', error);
    res.status(500).json({ success: false, message: 'Server error getting job applications' });
  }
};

// @desc    Get applications submitted by logged-in worker
// @route   GET /api/applications/worker/me
// @access  Private (Worker)
exports.getWorkerApplications = async (req, res) => {
  try {
    const apps = await prisma.jobApplication.findMany({
      where: { workerId: req.user.id },
      include: {
        job: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = apps.map((application) => ({
      id: application.id,
      jobId: application.jobId,
      jobTitle: application.job?.title || '',
      quote: Number(application.quoteAmount || 0),
      message: application.coverMessage || '',
      status: statusMap[application.status] || 'Pending'
    }));

    res.json({ success: true, count: formatted.length, applications: formatted });
  } catch (error) {
    console.error('[Application Controller] getWorkerApplications error:', error);
    res.status(500).json({ success: false, message: 'Server error getting worker applications' });
  }
};

// @desc    Accept a quote proposal
// @route   PUT /api/applications/:id/accept
// @access  Private (Customer)
exports.acceptQuote = async (req, res) => {
  try {
    const app = await prisma.jobApplication.findUnique({
      where: { id: req.params.id },
      include: {
        job: true,
        worker: { select: { id: true, name: true, avatarUrl: true } }
      }
    });

    if (!app) {
      return res.status(404).json({ success: false, message: 'Quote proposal not found' });
    }

    if (app.job.customerId !== req.user.id && req.user.role !== 'Admin') {
      return res.status(403).json({ success: false, message: 'Only the customer who posted the job can accept quotes.' });
    }

    // A worker whose verification was withdrawn since quoting can no longer be hired.
    const eligibility = await getWorkerEligibility(app.workerId);
    if (!eligibility.eligible) {
      return res.status(409).json({ success: false, code: NOT_VERIFIED_CODE, message: NOT_VERIFIED_MESSAGE });
    }

    const updatedApp = await prisma.jobApplication.update({
      where: { id: req.params.id },
      data: { status: 'ACCEPTED' }
    });

    await prisma.jobPost.update({
      where: { id: app.jobId },
      data: { status: 'IN_PROGRESS' }
    });

    // The worker's quote is their confirmed price: create the booking (once per job) so the customer can pay for it
    // through the normal payment flow.
    let booking = await prisma.booking.findFirst({ where: { jobPostId: app.jobId } });
    const createdNow = !booking;
    if (!booking) {
      booking = await prisma.booking.create({
        data: {
          bookingNumber: `BK-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`,
          customerId: app.job.customerId, workerId: app.workerId, jobPostId: app.jobId, addressId: app.job.addressId || null,
          status: 'CONFIRMED', priceConfirmedAt: new Date(), agreedPrice: app.quoteAmount,
          scheduledAt: app.job.scheduledDate || new Date(Date.now() + 24 * 3600 * 1000), timeSlot: app.job.scheduledSlot || 'Flexible',
          problemDescription: String(app.job.description || '').slice(0, 1000) || null,
          statusHistory: { create: { fromStatus: 'REQUESTED', toStatus: 'CONFIRMED', changedById: req.user.id, reason: 'Customer accepted the professional\'s quote' } }
        }
      });
    }

    if (createdNow) {
      await notifyUser({
        userId: app.workerId, type: 'QUOTE_ACCEPTED', bookingId: booking.id, title: 'Your quote was accepted',
        message: `${req.user.name || 'The customer'} accepted your quote of ₹${Number(app.quoteAmount)} for "${String(app.job.title || 'their job').slice(0, 80)}". They can now pay to secure the booking.`
      });
    }

    res.json({
      success: true,
      message: 'Quote accepted. You can now pay for the booking.',
      bookingId: booking.id,
      application: formatApplication({
        ...updatedApp,
        worker: app.worker
      })
    });
  } catch (error) {
    console.error('[Application Controller] acceptQuote error:', error);
    res.status(500).json({ success: false, message: 'Server error accepting quote' });
  }
};
