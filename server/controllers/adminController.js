const prisma = require('../config/prisma');

// @desc    Get system-wide governance metrics
// @route   GET /api/admin/metrics
// @access  Private (Admin)
exports.getMetrics = async (req, res) => {
  try {
    const [
      totalUsers,
      totalWorkers,
      totalCustomers,
      verifiedWorkers,
      totalJobs,
      activeJobs,
      completedJobs,
      flaggedJobs,
      totalApplications,
      activeBookings,
      totalBookings,
      paymentsAll,
      settlementsHeld,
      settlementsEarned
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'WORKER' } }),
      prisma.user.count({ where: { role: 'CUSTOMER' } }),
      prisma.workerProfile.count({ where: { verificationStatus: 'VERIFIED' } }),
      prisma.jobPost.count(),
      prisma.jobPost.count({ where: { status: { in: ['OPEN', 'QUOTED', 'ASSIGNED', 'IN_PROGRESS'] } } }),
      prisma.jobPost.count({ where: { status: 'COMPLETED' } }),
      prisma.jobPost.count({ where: { isFlagged: true } }),
      prisma.jobApplication.count(),
      prisma.booking.count({ where: { status: { in: ['CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'] } } }),
      prisma.booking.count(),
      prisma.payment.aggregate({ where: { state: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } }, _sum: { totalAmount: true, platformFee: true, amountRefunded: true }, _count: { id: true } }),
      prisma.workerSettlement.aggregate({ where: { status: { in: ['PENDING_COMPLETION', 'BLOCKED'] } }, _sum: { netAmount: true }, _count: { id: true } }),
      prisma.workerSettlement.aggregate({ where: { status: { in: ['ELIGIBLE', 'PAYOUT_PROCESSING', 'PAID'] } }, _sum: { netAmount: true, commission: true }, _count: { id: true } })
    ]);

    // Platform revenue = platform fees on payments that were actually captured, plus commission on confirmed jobs.
    const revenue = Number(paymentsAll._sum?.platformFee || 0) + Number(settlementsEarned._sum?.commission || 0);
    const totalTransactionVolume = Number(paymentsAll._sum?.totalAmount || 0);
    const heldInEscrow = Number(settlementsHeld._sum?.netAmount || 0); // key kept for the admin UI: captured, awaiting completion/dispute
    const releasedToWorkers = Number(settlementsEarned._sum?.netAmount || 0);

    res.json({
      success: true,
      metrics: {
        totalUsers,
        totalWorkers,
        totalCustomers,
        verifiedWorkers,
        totalJobs,
        activeJobs,
        completedJobs,
        flaggedJobs,
        totalApplications,
        activeBookings,
        totalBookings,
        revenue,
        platformRevenue: revenue,
        escrowBalance: heldInEscrow,
        heldInEscrow,
        releasedToWorkers,
        totalTransactionVolume,
        paymentTotals: {
          awaitingCompletion: heldInEscrow,
          owedOrPaidToWorkers: releasedToWorkers,
          captured: totalTransactionVolume,
          refunded: Number(paymentsAll._sum?.amountRefunded || 0),
          count: paymentsAll._count?.id || 0
        }
      }
    });
  } catch (error) {
    console.error('[Admin Controller] getMetrics error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving admin metrics' });
  }
};

// @desc    Get all users for admin listing with search & pagination
// @route   GET /api/admin/users
// @access  Private (Admin)
exports.getAllUsers = async (req, res) => {
  try {
    const { page, limit, search, role, verificationStatus } = req.query;

    const where = {};

    if (role) {
      where.role = String(role).toUpperCase();
    }

    if (verificationStatus) {
      const vStatus = String(verificationStatus).toUpperCase();
      where.OR = [
        { verificationStatus: vStatus },
        { workerProfile: { verificationStatus: vStatus } }
      ];
    }

    if (search) {
      const term = String(search).trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
        { workerProfile: { businessName: { contains: term, mode: 'insensitive' } } }
      ];
    }

    const total = await prisma.user.count({ where });

    const take = limit ? Math.max(1, parseInt(limit, 10)) : undefined;
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const skip = take ? (pageNum - 1) * take : undefined;

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        avatarUrl: true,
        isActive: true,
        isEmailVerified: true,
        verificationStatus: true,
        createdAt: true,
        updatedAt: true,
        workerProfile: {
          select: {
            id: true,
            verificationStatus: true,
            businessName: true,
            rating: true,
            reviewsCount: true,
            completedJobsCount: true,
            primaryCategory: {
              select: {
                id: true,
                name: true,
                slug: true
              }
            }
          }
        }
      }
    });

    const formattedUsers = users.map((u) => {
      const roleName = u.role === 'WORKER' ? 'Worker' : u.role === 'ADMIN' ? 'Admin' : 'Customer';
      const status = u.workerProfile?.verificationStatus || u.verificationStatus || 'UNVERIFIED';
      return {
        id: u.id,
        _id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        role: roleName,
        avatarUrl: u.avatarUrl,
        isActive: u.isActive,
        isEmailVerified: u.isEmailVerified,
        verificationStatus: status,
        isVerified: status === 'VERIFIED',
        category: u.workerProfile?.primaryCategory?.name || 'N/A',
        rating: (u.workerProfile?.reviewsCount || 0) > 0 && u.workerProfile?.rating ? Number(u.workerProfile.rating) : null,
        reviewsCount: u.workerProfile?.reviewsCount || 0,
        businessName: u.workerProfile?.businessName || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt
      };
    });

    res.json({
      success: true,
      count: formattedUsers.length,
      total,
      page: pageNum,
      totalPages: take ? Math.ceil(total / take) : 1,
      users: formattedUsers
    });
  } catch (error) {
    console.error('[Admin Controller] getAllUsers error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving user accounts' });
  }
};

// @desc    Update user verification status and write audit log
// @route   PATCH /api/admin/users/:id/verify
// @access  Private (Admin)
exports.verifyUser = async (req, res) => {
  try {
    const { id } = req.params;
    const requestedStatus = String(req.body.status || 'VERIFIED').toUpperCase();
    const validStatuses = ['VERIFIED', 'PENDING_REVIEW', 'UNVERIFIED', 'REJECTED'];

    if (!validStatuses.includes(requestedStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid verification status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      include: { workerProfile: true }
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const previousStatus = user.workerProfile?.verificationStatus || user.verificationStatus || 'UNVERIFIED';

    // Worker verification is decided ONLY through the document-review workflow
    // (/api/admin/worker-verifications). This endpoint can no longer grant a worker VERIFIED or fake a
    // pending state; it may still withdraw/decline (UNVERIFIED, REJECTED), which keeps the review
    // record consistent. Non-worker accounts are unaffected.
    const isWorker = user.role === 'WORKER';
    if (isWorker && !['UNVERIFIED', 'REJECTED'].includes(requestedStatus)) {
      await prisma.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'WORKER_DIRECT_VERIFICATION_BLOCKED',
          entityType: 'USER',
          entityId: user.id,
          details: { targetUserId: user.id, targetEmail: user.email, requestedStatus, previousStatus, adminId: req.user.id, adminEmail: req.user.email },
          ipAddress: req.ip || null,
          userAgent: req.headers?.['user-agent'] || null
        }
      }).catch((e) => console.error('[Admin Controller] audit write failed:', e.message));
      return res.status(409).json({
        success: false,
        code: 'WORKER_VERIFICATION_REQUIRES_REVIEW',
        message: 'Workers cannot be verified directly. Review their documents under Worker Verification and approve the application there.'
      });
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        // Admin identity/profile verification is separate from email-ownership verification,
        // which is only ever set after the user completes the emailed verification link.
        verificationStatus: requestedStatus
      }
    });

    // If user is a worker, update worker profile verificationStatus
    if (user.role === 'WORKER') {
      if (user.workerProfile) {
        await prisma.workerProfile.update({
          where: { id: user.workerProfile.id },
          data: {
            verificationStatus: requestedStatus,
            ...(req.body.isBackgroundChecked !== undefined ? { isBackgroundChecked: Boolean(req.body.isBackgroundChecked) } : {}),
            ...(req.body.isInsured !== undefined ? { isInsured: Boolean(req.body.isInsured) } : {})
          }
        });
      }
    }

    // Withdrawing a worker's verification also closes their review record so they can resubmit.
    if (isWorker) {
      const onboarding = await prisma.workerOnboarding.findUnique({ where: { userId: user.id } });
      if (onboarding && ['PENDING', 'UNDER_REVIEW', 'VERIFIED'].includes(onboarding.status)) {
        const reason = (typeof req.body.notes === 'string' && req.body.notes.trim()) || 'Verification was withdrawn by an administrator.';
        await prisma.workerOnboarding.update({
          where: { id: onboarding.id },
          data: { status: 'REJECTED', decisionReason: reason, reviewedAt: new Date(), reviewedById: req.user.id }
        });
        await prisma.workerVerificationEvent.create({
          data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: 'VERIFICATION_WITHDRAWN', fromStatus: onboarding.status, toStatus: 'REJECTED', reason }
        });
      }
    }

    // Write administrative AuditLog row
    const auditLog = await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'USER_VERIFICATION_UPDATED',
        entityType: 'USER',
        entityId: user.id,
        details: {
          targetUserId: user.id,
          targetEmail: user.email,
          targetRole: user.role,
          previousStatus,
          newStatus: requestedStatus,
          notes: req.body.notes || null,
          adminEmail: req.user.email,
          adminId: req.user.id
        },
        ipAddress: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null
      }
    });

    res.json({
      success: true,
      message: `User verification status set to ${requestedStatus}`,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        verificationStatus: requestedStatus,
        isVerified: requestedStatus === 'VERIFIED'
      },
      auditLogId: auditLog.id
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    console.error('[Admin Controller] verifyUser error:', error);
    res.status(500).json({ success: false, message: 'Server error updating user verification' });
  }
};

// @desc    Delete a user account
// @route   DELETE /api/admin/users/:id
// @access  Private (Admin)
exports.deleteUser = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await prisma.user.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'USER_DELETED',
        entityType: 'USER',
        entityId: req.params.id,
        details: {
          deletedUserEmail: user.email,
          deletedUserName: user.name,
          deletedUserRole: user.role,
          adminEmail: req.user.email
        },
        ipAddress: req.ip || null,
        userAgent: req.headers?.['user-agent'] || null
      }
    }).catch(e => console.error('[Admin Controller] AuditLog create error:', e.message));

    res.json({ success: true, message: 'User account removed successfully' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    console.error('[Admin Controller] deleteUser error:', error);
    res.status(500).json({ success: false, message: 'Server error removing user' });
  }
};

// @desc    Get all job requests for moderation with filters
// @route   GET /api/admin/jobs
// @access  Private (Admin)
exports.getAllJobs = async (req, res) => {
  try {
    const { page, limit, search, status, isFlagged } = req.query;

    const where = {};

    if (status) {
      where.status = String(status).toUpperCase();
    }

    if (isFlagged !== undefined) {
      where.isFlagged = isFlagged === 'true' || isFlagged === true;
    }

    if (search) {
      const term = String(search).trim();
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { customer: { name: { contains: term, mode: 'insensitive' } } },
        { category: { name: { contains: term, mode: 'insensitive' } } }
      ];
    }

    const total = await prisma.jobPost.count({ where });

    const take = limit ? Math.max(1, parseInt(limit, 10)) : undefined;
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const skip = take ? (pageNum - 1) * take : undefined;

    const jobs = await prisma.jobPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        customer: { select: { id: true, name: true, email: true } },
        category: { select: { id: true, name: true, slug: true } },
        _count: { select: { applications: true } }
      }
    });

    const formattedJobs = jobs.map((j) => {
      const minBudget = j.budgetMin != null ? Number(j.budgetMin) : null;
      const maxBudget = j.budgetMax != null ? Number(j.budgetMax) : null;
      const budgetText = minBudget !== null
        ? (maxBudget !== null && maxBudget !== minBudget ? `₹${minBudget} - ₹${maxBudget}` : `₹${minBudget}`)
        : 'Flexible';

      return {
        id: j.id,
        _id: j.id,
        title: j.title,
        description: j.description,
        category: j.category?.name || 'Other',
        budget: budgetText,
        status: j.status,
        customerName: j.customer?.name || 'Anonymous',
        customerId: j.customer?.id,
        customerEmail: j.customer?.email,
        isFlagged: Boolean(j.isFlagged),
        flagReason: j.flagReason || null,
        flaggedAt: j.flaggedAt,
        applicationsCount: j._count?.applications || 0,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt
      };
    });

    res.json({
      success: true,
      count: formattedJobs.length,
      total,
      page: pageNum,
      totalPages: take ? Math.ceil(total / take) : 1,
      jobs: formattedJobs
    });
  } catch (error) {
    console.error('[Admin Controller] getAllJobs error:', error);
    res.status(500).json({ success: false, message: 'Server error retrieving jobs' });
  }
};

// @desc    Flag/Unflag a job post for review
// @route   PATCH /api/admin/jobs/:id/flag
// @access  Private (Admin)
exports.flagJob = async (req, res) => {
  try {
    const { id } = req.params;
    const shouldFlag = req.body.isFlagged !== false && req.body.action !== 'unflag';
    const reason = shouldFlag ? (req.body.reason || 'Flagged by administrator for review') : null;

    const job = await prisma.jobPost.findUnique({
      where: { id },
      include: { customer: { select: { name: true, email: true } } }
    });

    if (!job) {
      return res.status(404).json({ success: false, message: 'Job post not found' });
    }

    const updatedJob = await prisma.jobPost.update({
      where: { id },
      data: {
        isFlagged: shouldFlag,
        flagReason: reason,
        flaggedAt: shouldFlag ? new Date() : null,
        ...(shouldFlag && req.body.setStatus ? { status: 'FLAGGED' } : {})
      }
    });

    // Write AuditLog row
    const auditLog = await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: shouldFlag ? 'JOB_FLAGGED' : 'JOB_UNFLAGGED',
        entityType: 'JOB_POST',
        entityId: job.id,
        details: {
          jobId: job.id,
          jobTitle: job.title,
          customerName: job.customer?.name,
          reason,
          adminEmail: req.user.email,
          adminId: req.user.id
        },
        ipAddress: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null
      }
    });

    res.json({
      success: true,
      message: shouldFlag ? 'Job post flagged successfully' : 'Job flag cleared successfully',
      job: {
        id: updatedJob.id,
        title: updatedJob.title,
        status: updatedJob.status,
        isFlagged: updatedJob.isFlagged,
        flagReason: updatedJob.flagReason,
        flaggedAt: updatedJob.flaggedAt
      },
      auditLogId: auditLog.id
    });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Job post not found' });
    }
    console.error('[Admin Controller] flagJob error:', error);
    res.status(500).json({ success: false, message: 'Server error moderating job post' });
  }
};

// @desc    Delete/Moderate a job post
// @route   DELETE /api/admin/jobs/:id
// @access  Private (Admin)
exports.deleteJob = async (req, res) => {
  try {
    const job = await prisma.jobPost.findUnique({ where: { id: req.params.id } });
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job post not found' });
    }

    await prisma.jobPost.delete({ where: { id: req.params.id } });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'JOB_DELETED',
        entityType: 'JOB_POST',
        entityId: req.params.id,
        details: {
          deletedJobTitle: job.title,
          adminEmail: req.user.email
        },
        ipAddress: req.ip || null,
        userAgent: req.headers?.['user-agent'] || null
      }
    }).catch(e => console.error('[Admin Controller] AuditLog create error:', e.message));

    res.json({ success: true, message: 'Job post removed successfully' });
  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Job post not found' });
    }
    console.error('[Admin Controller] deleteJob error:', error);
    res.status(500).json({ success: false, message: 'Server error moderating job post' });
  }
};
