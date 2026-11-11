// Admin review of worker onboarding submissions and their private identity/professional documents.
// Mounted under /api/admin, behind protect + authorize('Admin'). Every state change is guarded by the
// current status (409 otherwise), recorded as a verification event, written to AuditLog and notified.
const prisma = require('../config/prisma');
const storage = require('../services/documentStorage');
const ob = require('../services/workerOnboarding');

const REVIEWABLE = ['PENDING', 'UNDER_REVIEW'];
const DOC_DECISIONS = ['VERIFIED', 'REJECTED', 'RESUBMISSION_REQUIRED'];
const DEFAULT_QUEUE = ['PENDING', 'UNDER_REVIEW', 'RESUBMISSION_REQUIRED'];
const ALL_STATUSES = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'RESUBMISSION_REQUIRED'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const sendError = (res, error, label) => {
  if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
  console.error(`[Worker Verification] ${label}:`, error);
  return res.status(500).json({ success: false, message: `Server error during ${label}` });
};
const reasonFrom = (body, min = 10) => {
  const reason = typeof (body && body.reason) === 'string' ? body.reason.trim() : '';
  if (reason.length < min) throw httpError(400, `Please give a reason (at least ${min} characters) that the worker can act on.`);
  return reason.slice(0, 1000);
};

const loadSubmission = async (userId) => {
  const onboarding = await prisma.workerOnboarding.findUnique({
    where: { userId: String(userId) },
    include: { documents: { orderBy: { createdAt: 'asc' } } }
  });
  if (!onboarding || !onboarding.status) throw httpError(404, 'No submitted onboarding found for this worker.');
  return onboarding;
};

const audit = (req, action, onboarding, details = {}) => prisma.auditLog.create({
  data: {
    userId: req.user.id,
    action,
    entityType: 'WORKER_ONBOARDING',
    entityId: onboarding.id,
    details: { targetUserId: onboarding.userId, adminId: req.user.id, adminEmail: req.user.email, ...details },
    ipAddress: req.ip || null,
    userAgent: (req.headers && req.headers['user-agent']) || null
  }
});

const notify = (userId, title, message) => prisma.notification.create({
  data: { userId, title, message, type: 'SYSTEM_ALERT', linkUrl: 'worker-dashboard.html' }
}).catch((e) => console.error('[Worker Verification] notification failed:', e.message));

const docView = (d) => ({
  id: d.id, type: d.type, typeLabel: (ob.DOCUMENT_TYPES[d.type] || {}).label || d.type, group: (ob.DOCUMENT_TYPES[d.type] || {}).group,
  originalName: d.originalName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, status: d.status, rejectionReason: d.rejectionReason,
  isCurrent: d.isCurrent, reviewedAt: d.reviewedAt, createdAt: d.createdAt
});

// Atomically move the submission from one of `from` statuses to `to`, or 409.
const transition = async (tx, onboarding, from, to, data = {}) => {
  const result = await tx.workerOnboarding.updateMany({
    where: { id: onboarding.id, status: { in: from } },
    data: { status: to, ...data }
  });
  if (result.count !== 1) throw httpError(409, 'This submission was just changed by someone else. Reload and try again.');
};

const mirrorLegacyStatus = async (tx, userId, status) => {
  const legacy = ob.toLegacyStatus(status);
  await tx.user.update({ where: { id: userId }, data: { verificationStatus: legacy } });
  await tx.workerProfile.updateMany({ where: { userId }, data: { verificationStatus: legacy } });
};

// ── Queue & detail ───────────────────────────────────────────────────────────

// @route GET /api/admin/worker-verifications?status=&q=&page=&limit=
exports.listVerifications = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const statusParam = String(req.query.status || '').toUpperCase();
    const status = statusParam === 'ALL' ? { in: ALL_STATUSES } : ALL_STATUSES.includes(statusParam) ? statusParam : { in: DEFAULT_QUEUE };
    const q = String(req.query.q || '').trim();
    const where = {
      status,
      ...(q ? { user: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }] } } : {})
    };
    const [total, rows] = await Promise.all([
      prisma.workerOnboarding.count({ where }),
      prisma.workerOnboarding.findMany({
        where, orderBy: [{ submittedAt: 'asc' }], skip: (page - 1) * limit, take: limit,
        include: {
          user: { select: { id: true, name: true, email: true, phone: true, avatarUrl: true, workerProfile: { select: { primaryCategory: { select: { name: true } }, city: true } } } },
          documents: { where: { isCurrent: true }, select: { status: true } }
        }
      })
    ]);
    res.json({
      success: true, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)),
      submissions: rows.map((o) => ({
        userId: o.userId, name: o.user.name, email: o.user.email, phone: o.user.phone, avatarUrl: o.user.avatarUrl,
        category: o.user.workerProfile && o.user.workerProfile.primaryCategory ? o.user.workerProfile.primaryCategory.name : null,
        city: o.user.workerProfile ? o.user.workerProfile.city : null,
        status: o.status, submittedAt: o.submittedAt, attemptCount: o.attemptCount,
        documentCount: o.documents.length, documentsPending: o.documents.filter((d) => d.status === 'PENDING' || d.status === 'UNDER_REVIEW').length
      }))
    });
  } catch (error) {
    sendError(res, error, 'listing verifications');
  }
};

// @route GET /api/admin/worker-verifications/:userId
exports.getVerification = async (req, res) => {
  try {
    const onboarding = await loadSubmission(req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id: onboarding.userId },
      include: { workerProfile: { include: { primaryCategory: true, skills: true, availabilities: true, additionalCategories: { include: { category: true } } } } }
    });
    const events = await prisma.workerVerificationEvent.findMany({ where: { onboardingId: onboarding.id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const actorIds = [...new Set(events.map((e) => e.actorId).filter(Boolean))];
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));
    const p = user.workerProfile;
    const approval = ob.canApprove(onboarding.status, onboarding.documents);
    res.json({
      success: true,
      submission: {
        userId: user.id, status: onboarding.status, submittedAt: onboarding.submittedAt, attemptCount: onboarding.attemptCount,
        decisionReason: onboarding.decisionReason, reviewedAt: onboarding.reviewedAt,
        canApprove: approval.ok, approveBlockedReason: approval.ok ? null : approval.reason,
        worker: { name: user.name, email: user.email, emailVerified: user.isEmailVerified, phone: user.phone, avatarUrl: user.avatarUrl, createdAt: user.createdAt },
        profile: p ? {
          profession: p.primaryCategory && p.primaryCategory.name,
          additionalCategories: p.additionalCategories.map((c) => c.category.name),
          experienceYears: p.experienceYears, skills: p.skills.map((s) => s.skillName), description: p.bio,
          previousExperience: p.previousExperience, languages: p.languages,
          city: p.city, locality: p.locality, address: p.serviceAddress,
          hourlyRate: Number(p.hourlyRate), startingCharge: Number(p.inspectionFee), serviceRadiusKm: p.serviceRadiusKm,
          workingHours: p.availabilities.filter((a) => a.isActive).sort((a, b) => a.dayOfWeek - b.dayOfWeek).map((a) => ({ dayOfWeek: a.dayOfWeek, startTime: a.startTime, endTime: a.endTime }))
        } : null,
        documents: onboarding.documents.map(docView),
        history: events.map((e) => ({
          id: e.id, action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, reason: e.reason, documentId: e.documentId,
          actorRole: e.actorRole, actorName: actorName.get(e.actorId) || null, createdAt: e.createdAt
        }))
      }
    });
  } catch (error) {
    sendError(res, error, 'loading verification');
  }
};

// ── Documents ────────────────────────────────────────────────────────────────

// Mints a 2-minute signed URL for one stored document. Nothing else can read the private bucket.
// @route GET /api/admin/worker-verifications/:userId/documents/:docId/url
exports.getDocumentUrl = async (req, res) => {
  try {
    const onboarding = await loadSubmission(req.params.userId);
    const doc = onboarding.documents.find((d) => d.id === String(req.params.docId));
    if (!doc) throw httpError(404, 'Document not found for this worker.');
    const url = await storage.signedUrl(doc.storagePath);
    await audit(req, 'WORKER_DOCUMENT_VIEWED', onboarding, { documentId: doc.id, documentType: doc.type });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, url, expiresInSeconds: storage.SIGNED_URL_SECONDS, mimeType: doc.mimeType });
  } catch (error) {
    sendError(res, error, 'opening document');
  }
};

// @route PATCH /api/admin/worker-verifications/:userId/documents/:docId   body { status, reason }
exports.reviewDocument = async (req, res) => {
  try {
    const status = String((req.body && req.body.status) || '').toUpperCase();
    if (!DOC_DECISIONS.includes(status)) throw httpError(400, `status must be one of ${DOC_DECISIONS.join(', ')}.`);
    const reason = status === 'VERIFIED' ? null : reasonFrom(req.body, 5);

    const onboarding = await loadSubmission(req.params.userId);
    if (!REVIEWABLE.includes(onboarding.status)) throw httpError(409, 'Documents can only be reviewed while the submission is pending or under review.');
    const doc = onboarding.documents.find((d) => d.id === String(req.params.docId) && d.isCurrent);
    if (!doc) throw httpError(404, 'Document not found for this worker.');

    await prisma.$transaction(async (tx) => {
      if (onboarding.status === 'PENDING') {
        await transition(tx, onboarding, ['PENDING'], 'UNDER_REVIEW');
        await tx.workerVerificationEvent.create({ data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: 'REVIEW_STARTED', fromStatus: 'PENDING', toStatus: 'UNDER_REVIEW' } });
      }
      await tx.workerDocument.update({ where: { id: doc.id }, data: { status, rejectionReason: reason, reviewedById: req.user.id, reviewedAt: new Date() } });
      await tx.workerVerificationEvent.create({
        data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: `DOCUMENT_${status}`, documentId: doc.id, reason }
      });
    });
    await audit(req, `WORKER_DOCUMENT_${status}`, onboarding, { documentId: doc.id, documentType: doc.type, reason });
    res.json({ success: true, documentStatus: status });
  } catch (error) {
    sendError(res, error, 'reviewing document');
  }
};

// ── Decisions ────────────────────────────────────────────────────────────────

// @route POST /api/admin/worker-verifications/:userId/start-review
exports.startReview = async (req, res) => {
  try {
    const onboarding = await loadSubmission(req.params.userId);
    await prisma.$transaction(async (tx) => {
      await transition(tx, onboarding, ['PENDING'], 'UNDER_REVIEW');
      await tx.workerVerificationEvent.create({ data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: 'REVIEW_STARTED', fromStatus: 'PENDING', toStatus: 'UNDER_REVIEW' } });
    });
    await audit(req, 'WORKER_REVIEW_STARTED', onboarding);
    res.json({ success: true, status: 'UNDER_REVIEW' });
  } catch (error) {
    sendError(res, error, 'starting review');
  }
};

// @route POST /api/admin/worker-verifications/:userId/approve   body { notes? }
exports.approve = async (req, res) => {
  try {
    const onboarding = await loadSubmission(req.params.userId);
    const check = ob.canApprove(onboarding.status, onboarding.documents);
    if (!check.ok) throw httpError(409, check.reason);
    const notes = typeof (req.body && req.body.notes) === 'string' ? req.body.notes.trim().slice(0, 1000) || null : null;

    await prisma.$transaction(async (tx) => {
      await transition(tx, onboarding, REVIEWABLE, 'VERIFIED', { reviewedAt: new Date(), reviewedById: req.user.id, decisionReason: null });
      await mirrorLegacyStatus(tx, onboarding.userId, 'VERIFIED');
      await tx.workerVerificationEvent.create({ data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: 'APPROVED', fromStatus: onboarding.status, toStatus: 'VERIFIED', reason: notes } });
    });
    await audit(req, 'WORKER_VERIFIED', onboarding, { previousStatus: onboarding.status, newStatus: 'VERIFIED', notes });
    await notify(onboarding.userId, 'You are verified', 'Your LocalHire worker profile has been verified. The verified badge is now shown on your profile.');
    res.json({ success: true, status: 'VERIFIED' });
  } catch (error) {
    sendError(res, error, 'approving worker');
  }
};

// @route POST /api/admin/worker-verifications/:userId/reject   body { reason }
exports.reject = async (req, res) => {
  try {
    const reason = reasonFrom(req.body);
    const onboarding = await loadSubmission(req.params.userId);
    if (!REVIEWABLE.includes(onboarding.status)) throw httpError(409, 'Only pending or under-review submissions can be rejected.');

    await prisma.$transaction(async (tx) => {
      await transition(tx, onboarding, REVIEWABLE, 'REJECTED', { reviewedAt: new Date(), reviewedById: req.user.id, decisionReason: reason });
      await mirrorLegacyStatus(tx, onboarding.userId, 'REJECTED');
      await tx.workerVerificationEvent.create({ data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: 'REJECTED', fromStatus: onboarding.status, toStatus: 'REJECTED', reason } });
    });
    await audit(req, 'WORKER_REJECTED', onboarding, { previousStatus: onboarding.status, newStatus: 'REJECTED', reason });
    await notify(onboarding.userId, 'Verification not approved', `Your verification was not approved: ${reason} You can correct this and resubmit from your dashboard.`);
    res.json({ success: true, status: 'REJECTED' });
  } catch (error) {
    sendError(res, error, 'rejecting worker');
  }
};

// @route POST /api/admin/worker-verifications/:userId/request-resubmission   body { reason, documentIds? }
exports.requestResubmission = async (req, res) => {
  try {
    const reason = reasonFrom(req.body);
    const onboarding = await loadSubmission(req.params.userId);
    if (!REVIEWABLE.includes(onboarding.status)) throw httpError(409, 'Resubmission can only be requested for pending or under-review submissions.');

    const requested = Array.isArray(req.body.documentIds) ? req.body.documentIds.map(String) : [];
    const flagged = onboarding.documents.filter((d) => d.isCurrent && requested.includes(d.id) && d.status !== 'VERIFIED');
    if (requested.length && flagged.length !== requested.length) throw httpError(400, 'One or more selected documents are not eligible for resubmission.');

    await prisma.$transaction(async (tx) => {
      await transition(tx, onboarding, REVIEWABLE, 'RESUBMISSION_REQUIRED', { reviewedAt: new Date(), reviewedById: req.user.id, decisionReason: reason });
      await mirrorLegacyStatus(tx, onboarding.userId, 'RESUBMISSION_REQUIRED');
      if (flagged.length) {
        await tx.workerDocument.updateMany({
          where: { id: { in: flagged.map((d) => d.id) } },
          data: { status: 'RESUBMISSION_REQUIRED', rejectionReason: reason, reviewedById: req.user.id, reviewedAt: new Date() }
        });
      }
      await tx.workerVerificationEvent.create({ data: { onboardingId: onboarding.id, actorId: req.user.id, actorRole: 'ADMIN', action: 'RESUBMISSION_REQUESTED', fromStatus: onboarding.status, toStatus: 'RESUBMISSION_REQUIRED', reason } });
    });
    await audit(req, 'WORKER_RESUBMISSION_REQUESTED', onboarding, { previousStatus: onboarding.status, reason, documentIds: flagged.map((d) => d.id) });
    await notify(onboarding.userId, 'Action needed on your verification', `Please update your application: ${reason}`);
    res.json({ success: true, status: 'RESUBMISSION_REQUIRED' });
  } catch (error) {
    sendError(res, error, 'requesting resubmission');
  }
};
