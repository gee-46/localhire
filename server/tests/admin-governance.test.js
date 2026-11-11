const test = require('node:test');
const assert = require('node:assert/strict');

const prisma = require('../config/prisma');
const adminController = require('../controllers/adminController');
const { authorize } = require('../middlewares/authMiddleware');

function createMockResponse() {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
  return res;
}

test('Admin Governance 1: Non-admins receive 403 Forbidden from admin authorization middleware', async () => {
  const adminMiddleware = authorize('Admin');

  // Customer attempt
  const reqCustomer = { user: { id: 'cust-1', email: 'c@example.com', role: 'Customer' } };
  const resCustomer = createMockResponse();
  let nextCalledCustomer = false;

  adminMiddleware(reqCustomer, resCustomer, () => { nextCalledCustomer = true; });

  assert.equal(nextCalledCustomer, false, 'Next should not be called for Customer on admin route');
  assert.equal(resCustomer.statusCode, 403);
  assert.equal(resCustomer.payload.success, false);
  assert.match(resCustomer.payload.message, /not authorized/i);

  // Worker attempt
  const reqWorker = { user: { id: 'worker-1', email: 'w@example.com', role: 'Worker' } };
  const resWorker = createMockResponse();
  let nextCalledWorker = false;

  adminMiddleware(reqWorker, resWorker, () => { nextCalledWorker = true; });

  assert.equal(nextCalledWorker, false, 'Next should not be called for Worker on admin route');
  assert.equal(resWorker.statusCode, 403);
  assert.equal(resWorker.payload.success, false);

  // Unauthenticated attempt
  const reqUnauth = { user: null };
  const resUnauth = createMockResponse();
  let nextCalledUnauth = false;

  adminMiddleware(reqUnauth, resUnauth, () => { nextCalledUnauth = true; });

  assert.equal(nextCalledUnauth, false);
  assert.equal(resUnauth.statusCode, 403);

  // Admin allowed
  const reqAdmin = { user: { id: 'admin-1', email: 'admin@localhire.dev', role: 'Admin' } };
  const resAdmin = createMockResponse();
  let nextCalledAdmin = false;

  adminMiddleware(reqAdmin, resAdmin, () => { nextCalledAdmin = true; });

  assert.equal(nextCalledAdmin, true, 'Next must be called when user has Admin role');
});

test('Admin Governance 2: GET /metrics returns computed DB telemetry including revenue, bookings, and escrow totals', async () => {
  const origUserCount = prisma.user.count;
  const origWorkerCount = prisma.workerProfile.count;
  const origJobCount = prisma.jobPost.count;
  const origAppCount = prisma.jobApplication.count;
  const origBookingCount = prisma.booking.count;
  const origPaymentAggregate = prisma.payment.aggregate;
  const origSettlementAggregate = prisma.workerSettlement.aggregate;

  try {
    prisma.user.count = async (opts) => {
      if (opts?.where?.role === 'WORKER') return 12;
      if (opts?.where?.role === 'CUSTOMER') return 25;
      return 38; // total users
    };

    prisma.workerProfile.count = async (opts) => {
      if (opts?.where?.verificationStatus === 'VERIFIED') return 9;
      return 12;
    };

    prisma.jobPost.count = async (opts) => {
      if (opts?.where?.isFlagged) return 2;
      if (opts?.where?.status === 'COMPLETED') return 15;
      if (opts?.where?.status?.in) return 7; // active jobs
      return 24; // total jobs
    };

    prisma.jobApplication.count = async () => 45;

    prisma.booking.count = async (opts) => {
      if (opts?.where?.status?.in) return 5; // active bookings
      return 20; // total bookings
    };

    // captured payments: 23000 volume, 400 of platform fees, 500 refunded
    prisma.payment.aggregate = async () => ({ _sum: { totalAmount: 23000.00, platformFee: 400.00, amountRefunded: 500.00 }, _count: { id: 17 } });
    prisma.workerSettlement.aggregate = async (opts) => {
      if (opts?.where?.status?.in?.includes('PENDING_COMPLETION')) return { _sum: { netAmount: 4500.00 }, _count: { id: 3 } };
      return { _sum: { netAmount: 17575.00, commission: 925.00 }, _count: { id: 14 } };
    };

    const req = { user: { id: 'admin-1', role: 'Admin', email: 'admin@localhire.dev' } };
    const res = createMockResponse();

    await adminController.getMetrics(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    const m = res.payload.metrics;

    assert.equal(m.totalUsers, 38);
    assert.equal(m.totalWorkers, 12);
    assert.equal(m.totalCustomers, 25);
    assert.equal(m.verifiedWorkers, 9);
    assert.equal(m.totalJobs, 24);
    assert.equal(m.activeJobs, 7);
    assert.equal(m.completedJobs, 15);
    assert.equal(m.flaggedJobs, 2);
    assert.equal(m.activeBookings, 5);
    assert.equal(m.totalBookings, 20);

    // Revenue & Escrow totals computed from DB aggregates
    assert.equal(m.revenue, 1325.00, 'platform fees (400) + commission on confirmed jobs (925)');
    assert.equal(m.platformRevenue, 1325.00);
    assert.equal(m.escrowBalance, 4500.00, 'captured, awaiting completion or dispute');
    assert.equal(m.heldInEscrow, 4500.00);
    assert.equal(m.releasedToWorkers, 17575.00);
    assert.equal(m.totalTransactionVolume, 23000.00);
    assert.equal(m.paymentTotals.refunded, 500.00);
    assert.equal(m.paymentTotals.awaitingCompletion, 4500.00);
  } finally {
    prisma.user.count = origUserCount;
    prisma.workerProfile.count = origWorkerCount;
    prisma.jobPost.count = origJobCount;
    prisma.jobApplication.count = origAppCount;
    prisma.booking.count = origBookingCount;
    prisma.payment.aggregate = origPaymentAggregate;
    prisma.workerSettlement.aggregate = origSettlementAggregate;
  }
});

// Worker verification is decided only by the document-review workflow. The legacy shortcut may no longer
// grant VERIFIED (or fake a pending state) to a worker; it is audit-logged when attempted.
function withMockedAdminDb(fn) {
  return async () => {
    const orig = {
      findUnique: prisma.user.findUnique, userUpdate: prisma.user.update,
      workerUpdate: prisma.workerProfile.update, auditCreate: prisma.auditLog.create,
      onboardingFind: prisma.workerOnboarding.findUnique
    };
    const calls = { userUpdate: null, workerUpdate: null, audit: null };
    prisma.user.update = async ({ where, data }) => { calls.userUpdate = { where, data }; return { id: where.id, name: 'Jane Smith', email: 'jane@example.com', role: 'WORKER', verificationStatus: data.verificationStatus }; };
    prisma.workerProfile.update = async ({ where, data }) => { calls.workerUpdate = { where, data }; return { id: where.id, ...data }; };
    prisma.auditLog.create = async ({ data }) => { calls.audit = data; return { id: 'audit-log-1', ...data }; };
    prisma.workerOnboarding.findUnique = async () => null;
    try { await fn(calls); } finally {
      prisma.user.findUnique = orig.findUnique; prisma.user.update = orig.userUpdate;
      prisma.workerProfile.update = orig.workerUpdate; prisma.auditLog.create = orig.auditCreate;
      prisma.workerOnboarding.findUnique = orig.onboardingFind;
    }
  };
}
const adminReq = (status, notes) => ({
  params: { id: 'target-1' }, body: { status, notes },
  user: { id: 'admin-99', email: 'admin@localhire.dev', role: 'Admin' }, ip: '127.0.0.1', headers: { 'user-agent': 'NodeTestAgent/1.0' }
});
const targetUser = (role, profileStatus) => async ({ where }) => (where.id === 'target-1' ? {
  id: 'target-1', name: 'Jane Smith', email: 'jane@example.com', role, verificationStatus: profileStatus,
  workerProfile: role === 'WORKER' ? { id: 'wp-1', verificationStatus: profileStatus, businessName: 'Smith Plumbing' } : null
} : null);

test('Admin Governance 3: the legacy shortcut cannot verify a worker, and the attempt is audit-logged', withMockedAdminDb(async (calls) => {
  prisma.user.findUnique = targetUser('WORKER', 'UNVERIFIED');
  for (const status of ['VERIFIED', 'PENDING_REVIEW']) {
    calls.userUpdate = calls.workerUpdate = calls.audit = null;
    const res = createMockResponse();
    await adminController.verifyUser(adminReq(status, 'Government ID verified'), res);
    assert.equal(res.statusCode, 409, status);
    assert.equal(res.payload.code, 'WORKER_VERIFICATION_REQUIRES_REVIEW');
    assert.equal(calls.userUpdate, null, 'no user row is modified');
    assert.equal(calls.workerUpdate, null, 'no worker profile is modified');
    assert.equal(calls.audit.action, 'WORKER_DIRECT_VERIFICATION_BLOCKED');
    assert.equal(calls.audit.userId, 'admin-99');
    assert.equal(calls.audit.details.requestedStatus, status);
  }
}));

test('Admin Governance 3b: a worker\'s verification can still be withdrawn (audit-logged, email flag untouched)', withMockedAdminDb(async (calls) => {
  prisma.user.findUnique = targetUser('WORKER', 'VERIFIED');
  const res = createMockResponse();
  await adminController.verifyUser(adminReq('REJECTED', 'Documents found to be invalid'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.userUpdate.data.verificationStatus, 'REJECTED');
  assert.equal(calls.userUpdate.data.isEmailVerified, undefined);
  assert.equal(calls.workerUpdate.data.verificationStatus, 'REJECTED');
  assert.equal(calls.audit.action, 'USER_VERIFICATION_UPDATED');
  assert.equal(calls.audit.details.previousStatus, 'VERIFIED');
  assert.equal(calls.audit.details.newStatus, 'REJECTED');
}));

test('Admin Governance 3c: non-worker accounts are unaffected by the worker restriction', withMockedAdminDb(async (calls) => {
  prisma.user.findUnique = targetUser('CUSTOMER', 'UNVERIFIED');
  const res = createMockResponse();
  await adminController.verifyUser(adminReq('VERIFIED', 'Checked'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.userUpdate.data.verificationStatus, 'VERIFIED');
  assert.equal(calls.userUpdate.data.isEmailVerified, undefined);
  assert.equal(calls.audit.action, 'USER_VERIFICATION_UPDATED');
}));

test('Admin Governance 4: PATCH /users/:id/verify rejects invalid status values with 400', async () => {
  const req = {
    params: { id: 'target-1' },
    body: { status: 'INVALID_STATUS_FOO' },
    user: { id: 'admin-1', role: 'Admin' }
  };
  const res = createMockResponse();

  await adminController.verifyUser(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.match(res.payload.message, /invalid verification status/i);
});

test('Admin Governance 5: PATCH /jobs/:id/flag flags job post and writes AuditLog row', async () => {
  const origFindUnique = prisma.jobPost.findUnique;
  const origJobUpdate = prisma.jobPost.update;
  const origAuditCreate = prisma.auditLog.create;

  let capturedJobUpdate = null;
  let capturedAuditLog = null;

  try {
    prisma.jobPost.findUnique = async ({ where }) => {
      if (where.id === 'job-101') {
        return {
          id: 'job-101',
          title: 'Suspicious Job Post',
          isFlagged: false,
          customer: { name: 'Sus Customer', email: 'sus@example.com' }
        };
      }
      return null;
    };

    prisma.jobPost.update = async ({ where, data }) => {
      capturedJobUpdate = { where, data };
      return {
        id: where.id,
        title: 'Suspicious Job Post',
        status: data.status || 'OPEN',
        isFlagged: data.isFlagged,
        flagReason: data.flagReason,
        flaggedAt: data.flaggedAt
      };
    };

    prisma.auditLog.create = async ({ data }) => {
      capturedAuditLog = data;
      return { id: 'audit-flag-1', ...data };
    };

    const req = {
      params: { id: 'job-101' },
      body: { reason: 'Violates terms of service - inappropriate solicitation', isFlagged: true },
      user: { id: 'admin-77', email: 'moderator@localhire.dev', role: 'Admin' },
      ip: '192.168.1.10',
      headers: { 'user-agent': 'TestModerator/2.0' }
    };
    const res = createMockResponse();

    await adminController.flagJob(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.job.isFlagged, true);
    assert.equal(res.payload.job.flagReason, 'Violates terms of service - inappropriate solicitation');

    // DB updates
    assert.equal(capturedJobUpdate.data.isFlagged, true);
    assert.equal(capturedJobUpdate.data.flagReason, 'Violates terms of service - inappropriate solicitation');
    assert.ok(capturedJobUpdate.data.flaggedAt instanceof Date);

    // Audit trail
    assert.ok(capturedAuditLog);
    assert.equal(capturedAuditLog.action, 'JOB_FLAGGED');
    assert.equal(capturedAuditLog.entityType, 'JOB_POST');
    assert.equal(capturedAuditLog.entityId, 'job-101');
    assert.equal(capturedAuditLog.details.adminEmail, 'moderator@localhire.dev');
  } finally {
    prisma.jobPost.findUnique = origFindUnique;
    prisma.jobPost.update = origJobUpdate;
    prisma.auditLog.create = origAuditCreate;
  }
});

test('Admin Governance 6: PATCH /jobs/:id/flag allows unflagging and writes unflag AuditLog row', async () => {
  const origFindUnique = prisma.jobPost.findUnique;
  const origJobUpdate = prisma.jobPost.update;
  const origAuditCreate = prisma.auditLog.create;

  let capturedJobUpdate = null;
  let capturedAuditLog = null;

  try {
    prisma.jobPost.findUnique = async ({ where }) => {
      if (where.id === 'job-flagged-2') {
        return {
          id: 'job-flagged-2',
          title: 'Previously Flagged Job',
          isFlagged: true,
          flagReason: 'Under review',
          customer: { name: 'Honest John' }
        };
      }
      return null;
    };

    prisma.jobPost.update = async ({ where, data }) => {
      capturedJobUpdate = { where, data };
      return {
        id: where.id,
        title: 'Previously Flagged Job',
        isFlagged: data.isFlagged,
        flagReason: data.flagReason,
        flaggedAt: data.flaggedAt
      };
    };

    prisma.auditLog.create = async ({ data }) => {
      capturedAuditLog = data;
      return { id: 'audit-unflag-1', ...data };
    };

    const req = {
      params: { id: 'job-flagged-2' },
      body: { isFlagged: false },
      user: { id: 'admin-1', email: 'admin@localhire.dev', role: 'Admin' }
    };
    const res = createMockResponse();

    await adminController.flagJob(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.job.isFlagged, false);
    assert.equal(res.payload.job.flagReason, null);

    assert.equal(capturedJobUpdate.data.isFlagged, false);
    assert.equal(capturedJobUpdate.data.flagReason, null);
    assert.equal(capturedAuditLog.action, 'JOB_UNFLAGGED');
  } finally {
    prisma.jobPost.findUnique = origFindUnique;
    prisma.jobPost.update = origJobUpdate;
    prisma.auditLog.create = origAuditCreate;
  }
});

test('Admin Governance 7: GET /users supports search, role filtering, and pagination', async () => {
  const origCount = prisma.user.count;
  const origFindMany = prisma.user.findMany;

  let capturedWhere = null;
  let capturedSkip = null;
  let capturedTake = null;

  try {
    prisma.user.count = async ({ where }) => {
      capturedWhere = where;
      return 15;
    };

    prisma.user.findMany = async ({ where, skip, take }) => {
      capturedSkip = skip;
      capturedTake = take;
      return [
        {
          id: 'u-1',
          name: 'Alice Plumber',
          email: 'alice@example.com',
          phone: '+91 9876543210',
          role: 'WORKER',
          avatarUrl: null,
          isActive: true,
          isEmailVerified: true,
          verificationStatus: 'VERIFIED',
          createdAt: new Date(),
          updatedAt: new Date(),
          workerProfile: {
            id: 'wp-1',
            verificationStatus: 'VERIFIED',
            businessName: 'Alice Quick Fix',
            rating: 4.9,
            reviewsCount: 22,
            completedJobsCount: 40,
            primaryCategory: { id: 'c-1', name: 'Plumber', slug: 'plumber' }
          }
        }
      ];
    };

    const req = {
      query: { page: '2', limit: '5', search: 'Alice', role: 'WORKER' },
      user: { id: 'admin-1', role: 'Admin' }
    };
    const res = createMockResponse();

    await adminController.getAllUsers(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.total, 15);
    assert.equal(res.payload.page, 2);
    assert.equal(res.payload.totalPages, 3);
    assert.equal(res.payload.count, 1);

    // Verify pagination passed to Prisma
    assert.equal(capturedSkip, 5); // (page 2 - 1) * 5
    assert.equal(capturedTake, 5);

    // Verify user formatting
    const first = res.payload.users[0];
    assert.equal(first.name, 'Alice Plumber');
    assert.equal(first.role, 'Worker');
    assert.equal(first.category, 'Plumber');
    assert.equal(first.rating, 4.9);
    assert.equal(first.verificationStatus, 'VERIFIED');
    assert.equal(first.isVerified, true);
    assert.equal(first.businessName, 'Alice Quick Fix');
  } finally {
    prisma.user.count = origCount;
    prisma.user.findMany = origFindMany;
  }
});

