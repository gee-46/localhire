// Worker-facing onboarding, document upload and dashboard endpoints.
// Every route is behind protect + authorize('Worker'); every query is scoped to req.user.id, so a
// worker can only ever read or change their own onboarding record and documents.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const storage = require('../services/documentStorage');
const ob = require('../services/workerOnboarding');
const publicImages = require('../services/publicImages');
const settlementService = require('../services/settlementService');
const reviewService = require('../services/reviewService');
const { realAvatarUrl } = require('../services/avatar');

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const PLACEHOLDER_PHONE = '+91 00000 00000';

const sendError = (res, error, label) => {
  if (error && error.status) return res.status(error.status).json({ success: false, message: error.message });
  console.error(`[Worker Controller] ${label}:`, error);
  return res.status(500).json({ success: false, message: `Server error during ${label}` });
};
const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const formatDocument = (d) => ({
  id: d.id,
  type: d.type,
  typeLabel: (ob.DOCUMENT_TYPES[d.type] || {}).label || d.type,
  group: (ob.DOCUMENT_TYPES[d.type] || {}).group || 'OTHER',
  originalName: d.originalName,
  mimeType: d.mimeType,
  sizeBytes: d.sizeBytes,
  status: d.status,
  rejectionReason: d.rejectionReason || null,
  createdAt: d.createdAt
});

// ── Public: categories (single source for every dropdown) ───────────────────

// @route GET /api/categories
exports.listCategories = async (req, res) => {
  try {
    const categories = await prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, description: true }
    });
    res.json({ success: true, categories });
  } catch (error) {
    sendError(res, error, 'loading categories');
  }
};

// ── Loading helpers ──────────────────────────────────────────────────────────

const loadUser = (userId) => prisma.user.findUnique({
  where: { id: userId },
  include: {
    workerProfile: { include: { skills: true, availabilities: true, additionalCategories: true, primaryCategory: true } },
    workerOnboarding: true
  }
});

const getOrCreateOnboarding = async (userId) => {
  const existing = await prisma.workerOnboarding.findUnique({ where: { userId } });
  if (existing) return existing;
  try {
    return await prisma.workerOnboarding.create({ data: { userId, draft: {} } });
  } catch (e) {
    if (e.code === 'P2002') return prisma.workerOnboarding.findUnique({ where: { userId } });
    throw e;
  }
};

// Existing workers (created before onboarding existed) have a profile but no draft: pre-fill from it.
const draftFromProfile = (user) => {
  const p = user.workerProfile;
  const draft = {};
  draft.personal = {
    fullName: user.name || '',
    phone: user.phone && user.phone !== PLACEHOLDER_PHONE ? user.phone : '',
    city: (p && p.city) || '',
    locality: (p && p.locality) || '',
    address: (p && p.serviceAddress) || ''
  };
  if (p) {
    draft.professional = {
      categoryId: p.primaryCategoryId,
      experienceYears: p.experienceYears,
      skills: (p.skills || []).map((s) => s.skillName),
      description: p.bio || '',
      previousExperience: p.previousExperience || '',
      languages: p.languages || []
    };
    draft.service = {
      additionalCategoryIds: (p.additionalCategories || []).map((c) => c.categoryId),
      hourlyRate: num(p.hourlyRate) || null,
      startingCharge: num(p.inspectionFee) || null,
      serviceRadiusKm: p.serviceRadiusKm,
      workingHours: (p.availabilities || []).map((a) => ({ dayOfWeek: a.dayOfWeek, startTime: a.startTime, endTime: a.endTime, isActive: a.isActive }))
    };
  }
  return draft;
};

const effectiveStatus = (user) => {
  const onboarding = user.workerOnboarding;
  if (onboarding && onboarding.status) return onboarding.status;
  return null;
};

const assertCanEdit = (user, onboarding) => {
  const status = onboarding.status || null;
  if (!ob.canWorkerEdit(status)) {
    throw httpError(409, status === 'VERIFIED'
      ? 'Your profile is already verified. Use Edit Profile for routine changes.'
      : 'Your application is being reviewed and cannot be edited right now.');
  }
  if (!status && user.workerProfile && user.workerProfile.verificationStatus === 'VERIFIED') {
    throw httpError(409, 'Your profile is already verified by LocalHire. Use Edit Profile for routine changes.');
  }
};

const currentDocs = (onboardingId) => prisma.workerDocument.findMany({
  where: { onboardingId, isCurrent: true },
  orderBy: { createdAt: 'asc' }
});

const addEvent = (tx, data) => (tx || prisma).workerVerificationEvent.create({ data });

// ── Onboarding state ─────────────────────────────────────────────────────────

const buildState = async (user, onboarding) => {
  const docs = await currentDocs(onboarding.id);
  const stored = onboarding.draft && typeof onboarding.draft === 'object' ? onboarding.draft : {};
  const seed = draftFromProfile(user);
  const draft = { ...seed, ...stored };
  const status = onboarding.status || null;
  const legacyStatus = user.workerProfile ? user.workerProfile.verificationStatus : null;
  return {
    status,
    legacyVerificationStatus: legacyStatus,
    currentStep: onboarding.currentStep,
    totalSteps: ob.TOTAL_STEPS,
    canEdit: ob.canWorkerEdit(status) && !(status === null && legacyStatus === 'VERIFIED'),
    decisionReason: status === 'REJECTED' || status === 'RESUBMISSION_REQUIRED' ? onboarding.decisionReason : null,
    submittedAt: onboarding.submittedAt,
    account: { email: user.email, emailVerified: user.isEmailVerified, avatarUrl: realAvatarUrl(user.avatarUrl) },
    draft,
    documents: docs.map(formatDocument),
    documentTypes: Object.entries(ob.DOCUMENT_TYPES).map(([type, v]) => ({ type, ...v }))
  };
};

// @route GET /api/worker/onboarding
exports.getOnboarding = async (req, res) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const onboarding = await getOrCreateOnboarding(user.id);
    res.json({ success: true, onboarding: await buildState(user, onboarding) });
  } catch (error) {
    sendError(res, error, 'loading onboarding');
  }
};

// Lightweight: where should this worker land after login?
// @route GET /api/worker/status
exports.getStatus = async (req, res) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const status = effectiveStatus(user);
    const hasProfile = Boolean(user.workerProfile);
    const hasProgress = Boolean(user.workerOnboarding && (user.workerOnboarding.currentStep > 1 || Object.keys(user.workerOnboarding.draft || {}).length));
    let state;
    if (status) state = 'SUBMITTED';
    else if (hasProfile) state = 'LEGACY_PROFILE';
    else state = hasProgress ? 'DRAFT' : 'NOT_STARTED';
    res.json({ success: true, state, verificationStatus: status || (user.workerProfile ? user.workerProfile.verificationStatus : null) });
  } catch (error) {
    sendError(res, error, 'loading worker status');
  }
};

const categoryIdsExist = async (ids) => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return true;
  const count = await prisma.serviceCategory.count({ where: { id: { in: unique }, isActive: true } });
  return count === unique.length;
};

// @route PUT /api/worker/onboarding/step/:step   body { data, complete }
exports.saveStep = async (req, res) => {
  try {
    const step = Number(req.params.step);
    if (!Number.isInteger(step) || step < 1 || step > ob.TOTAL_STEPS) {
      return res.status(400).json({ success: false, message: 'Unknown onboarding step.' });
    }
    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const onboarding = await getOrCreateOnboarding(user.id);
    assertCanEdit(user, onboarding);

    const complete = req.body && req.body.complete === true;
    const { value, errors } = ob.validateStep(step, req.body && req.body.data);
    const problems = { ...errors };

    if (complete) {
      if (step === 1 && !realAvatarUrl(user.avatarUrl)) problems.photo = 'Upload a profile photograph.';
      if (step === 2 && value.categoryId && !(await categoryIdsExist([value.categoryId]))) problems.categoryId = 'Selected profession is not available.';
      if (step === 4 && !(await categoryIdsExist(value.additionalCategoryIds))) problems.additionalCategoryIds = 'A selected category is not available.';
      if (step === 3) {
        const docs = await currentDocs(onboarding.id);
        if (!docs.some((d) => ob.isIdentityType(d.type))) problems.identity = 'Upload one government-issued photo ID.';
      }
      if (Object.keys(problems).length) {
        return res.status(400).json({ success: false, message: 'Please fix the highlighted fields.', errors: problems });
      }
    }

    const stored = onboarding.draft && typeof onboarding.draft === 'object' ? onboarding.draft : {};
    const next = { ...stored, [ob.STEP_KEYS[step]]: value };
    const updated = await prisma.workerOnboarding.update({
      where: { id: onboarding.id },
      data: {
        draft: next,
        currentStep: complete ? Math.max(onboarding.currentStep, Math.min(step + 1, ob.TOTAL_STEPS)) : Math.max(onboarding.currentStep, 1)
      }
    });
    res.json({ success: true, saved: true, currentStep: updated.currentStep, errors: complete ? {} : errors });
  } catch (error) {
    sendError(res, error, 'saving onboarding');
  }
};

// ── Documents ────────────────────────────────────────────────────────────────

const MAX_DOCS_TOTAL = 12;
const MAX_DOCS_PER_TYPE = 3;

// @route POST /api/worker/onboarding/documents   multipart: file, type
exports.uploadDocument = async (req, res) => {
  let objectPath = null;
  try {
    const type = String((req.body && req.body.type) || '');
    if (!ob.DOCUMENT_TYPES[type]) return res.status(400).json({ success: false, message: 'Choose a valid document type.' });
    if (!req.file) return res.status(400).json({ success: false, message: 'No file was uploaded.' });

    const sniffed = storage.sniffMime(req.file.buffer);
    if (!sniffed || !storage.ALLOWED_TYPES.includes(sniffed)) {
      return res.status(400).json({ success: false, message: 'The file content is not a valid PDF, JPG, PNG or WebP.' });
    }
    if (req.file.size > storage.MAX_BYTES) {
      return res.status(400).json({ success: false, message: 'File is too large.' });
    }

    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const onboarding = await getOrCreateOnboarding(user.id);
    assertCanEdit(user, onboarding);

    const docs = await currentDocs(onboarding.id);
    if (docs.length >= MAX_DOCS_TOTAL) return res.status(400).json({ success: false, message: `You can keep at most ${MAX_DOCS_TOTAL} documents. Remove one first.` });
    if (docs.filter((d) => d.type === type).length >= MAX_DOCS_PER_TYPE) {
      return res.status(400).json({ success: false, message: `You already have ${MAX_DOCS_PER_TYPE} files of this type. Remove one first.` });
    }

    const id = crypto.randomUUID();
    // Server-generated key: the user's filename never reaches the storage path.
    objectPath = `${user.id}/${id}.${storage.EXTENSION[sniffed]}`;
    await storage.putObject(objectPath, req.file.buffer, sniffed);

    const originalName = String(req.file.originalname || 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    let doc;
    try {
      doc = await prisma.workerDocument.create({
        data: {
          id, userId: user.id, onboardingId: onboarding.id, type, originalName, mimeType: sniffed,
          sizeBytes: req.file.size, storageBucket: storage.BUCKET, storagePath: objectPath, status: 'PENDING'
        }
      });
    } catch (dbError) {
      await storage.removeObject(objectPath);
      throw dbError;
    }
    await addEvent(null, { onboardingId: onboarding.id, actorId: user.id, actorRole: 'WORKER', action: 'DOCUMENT_UPLOADED', documentId: doc.id, reason: type });
    res.status(201).json({ success: true, document: formatDocument(doc) });
  } catch (error) {
    sendError(res, error, 'uploading document');
  }
};

// @route DELETE /api/worker/onboarding/documents/:id   (soft: the file is kept for the audit trail)
exports.deleteDocument = async (req, res) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const onboarding = await getOrCreateOnboarding(user.id);
    assertCanEdit(user, onboarding);

    const doc = await prisma.workerDocument.findFirst({ where: { id: String(req.params.id), userId: user.id, isCurrent: true } });
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found.' });
    if (doc.status === 'VERIFIED') return res.status(409).json({ success: false, message: 'A verified document cannot be removed.' });

    await prisma.workerDocument.update({ where: { id: doc.id }, data: { isCurrent: false } });
    await addEvent(null, { onboardingId: onboarding.id, actorId: user.id, actorRole: 'WORKER', action: 'DOCUMENT_REMOVED', documentId: doc.id, reason: doc.type });
    res.json({ success: true });
  } catch (error) {
    sendError(res, error, 'removing document');
  }
};

// ── Submit / resubmit ────────────────────────────────────────────────────────

// @route POST /api/worker/onboarding/submit   body { declaration: true }
exports.submitOnboarding = async (req, res) => {
  try {
    const user = await loadUser(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const onboarding = await getOrCreateOnboarding(user.id);
    assertCanEdit(user, onboarding);

    const stored = onboarding.draft && typeof onboarding.draft === 'object' ? onboarding.draft : {};
    const draft = { ...draftFromProfile(user), ...stored, review: { declaration: Boolean(req.body && req.body.declaration === true) } };
    const docs = await currentDocs(onboarding.id);
    const allIds = (await prisma.serviceCategory.findMany({ where: { isActive: true }, select: { id: true } })).map((c) => c.id);

    const problems = ob.validateForSubmit({ draft, hasAvatar: Boolean(realAvatarUrl(user.avatarUrl)), documents: docs, categoryIds: allIds });
    if (problems.length) {
      return res.status(400).json({ success: false, message: 'Your application is incomplete.', problems });
    }

    const personal = ob.validateStep(1, draft.personal).value;
    const professional = ob.validateStep(2, draft.professional).value;
    const service = ob.validateStep(4, draft.service).value;
    const previous = onboarding.status || null;
    const legacy = ob.toLegacyStatus('PENDING');

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { name: personal.fullName, phone: personal.phone, verificationStatus: legacy }
      });
      const profileData = {
        primaryCategoryId: professional.categoryId,
        experienceYears: professional.experienceYears,
        bio: professional.description,
        previousExperience: professional.previousExperience || null,
        languages: professional.languages,
        hourlyRate: service.hourlyRate || 0,
        inspectionFee: service.startingCharge || 0,
        serviceRadiusKm: service.serviceRadiusKm,
        serviceAddress: personal.address,
        city: personal.city,
        locality: personal.locality,
        verificationStatus: legacy
      };
      const profile = await tx.workerProfile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, businessName: personal.fullName, ...profileData },
        update: profileData
      });
      await tx.professionalSkill.deleteMany({ where: { workerProfileId: profile.id } });
      await tx.professionalSkill.createMany({ data: professional.skills.map((skillName) => ({ workerProfileId: profile.id, skillName })) });
      await tx.professionalAvailability.deleteMany({ where: { workerProfileId: profile.id } });
      await tx.professionalAvailability.createMany({
        data: service.workingHours.map((h) => ({ workerProfileId: profile.id, dayOfWeek: h.dayOfWeek, startTime: h.startTime, endTime: h.endTime, isActive: h.isActive }))
      });
      await tx.workerProfileCategory.deleteMany({ where: { workerProfileId: profile.id } });
      const extra = service.additionalCategoryIds.filter((id) => id !== professional.categoryId);
      if (extra.length) await tx.workerProfileCategory.createMany({ data: extra.map((categoryId) => ({ workerProfileId: profile.id, categoryId })) });

      // Resubmitted/new documents go back to the queue; previously verified ones stay verified.
      await tx.workerDocument.updateMany({
        where: { onboardingId: onboarding.id, isCurrent: true, status: { in: ['UNDER_REVIEW'] } },
        data: { status: 'PENDING' }
      });
      await tx.workerOnboarding.update({
        where: { id: onboarding.id },
        data: {
          draft: { personal, professional, service, review: { declaration: true } },
          status: 'PENDING', submittedAt: new Date(), reviewedAt: null, reviewedById: null, decisionReason: null,
          attemptCount: { increment: 1 }, currentStep: ob.TOTAL_STEPS
        }
      });
      await addEvent(tx, {
        onboardingId: onboarding.id, actorId: user.id, actorRole: 'WORKER',
        action: previous ? 'RESUBMITTED' : 'SUBMITTED', fromStatus: previous, toStatus: 'PENDING'
      });
    });

    res.json({ success: true, message: 'Application submitted. We will review your documents and notify you.', status: 'PENDING' });
  } catch (error) {
    sendError(res, error, 'submitting onboarding');
  }
};

// ── Dashboard ────────────────────────────────────────────────────────────────

// @route GET /api/worker/dashboard
// Everything here is read from real records: nothing is estimated or invented.
exports.getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await loadUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const profile = user.workerProfile;
    const onboarding = user.workerOnboarding;
    const docs = onboarding ? await currentDocs(onboarding.id) : [];

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const categoryIds = profile ? [profile.primaryCategoryId, ...profile.additionalCategories.map((c) => c.categoryId)] : [];

    const [upcoming, requested, completedCount, earningsData, reviewAgg, reviews, jobCount, jobs, location] = await Promise.all([
      prisma.booking.findMany({
        where: { workerId: userId, status: { in: ['CONFIRMED', 'DISPATCHED', 'IN_PROGRESS'] }, scheduledAt: { gte: new Date(now.getTime() - 6 * 3600 * 1000) } },
        orderBy: { scheduledAt: 'asc' }, take: 5,
        include: { customer: { select: { name: true } }, serviceItem: { select: { title: true } } }
      }),
      prisma.booking.findMany({
        where: { workerId: userId, status: 'REQUESTED' }, orderBy: { scheduledAt: 'asc' }, take: 5,
        include: { customer: { select: { name: true } }, serviceItem: { select: { title: true } } }
      }),
      prisma.booking.count({ where: { workerId: userId, status: 'COMPLETED' } }),
      settlementService.getEarnings(userId),
      prisma.review.aggregate({ where: { workerId: userId, status: 'PUBLISHED' }, _avg: { rating: true }, _count: true }),
      prisma.review.findMany({ where: { workerId: userId, status: 'PUBLISHED' }, orderBy: { createdAt: 'desc' }, take: 5, include: { customer: { select: { name: true } } } }),
      categoryIds.length
        ? prisma.jobPost.count({ where: { categoryId: { in: categoryIds }, status: { in: ['OPEN', 'QUOTED'] }, isFlagged: false } })
        : Promise.resolve(0),
      categoryIds.length
        ? prisma.jobPost.findMany({
            where: { categoryId: { in: categoryIds }, status: { in: ['OPEN', 'QUOTED'] }, isFlagged: false },
            orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, title: true, urgency: true, budgetMin: true, budgetMax: true, createdAt: true }
          })
        : Promise.resolve([]),
      profile ? prisma.workerLocation.findUnique({ where: { workerProfileId: profile.id } }) : Promise.resolve(null)
    ]);

    const bookingView = (b) => ({
      id: b.id, bookingNumber: b.bookingNumber, status: b.status, scheduledAt: b.scheduledAt, timeSlot: b.timeSlot,
      customerName: b.customer ? b.customer.name : null, service: b.serviceItem ? b.serviceItem.title : null, agreedPrice: num(b.agreedPrice)
    });

    const status = onboarding && onboarding.status ? onboarding.status : null;
    res.json({
      success: true,
      hasProfile: Boolean(profile),
      worker: { name: user.name, avatarUrl: realAvatarUrl(user.avatarUrl), email: user.email },
      completion: ob.computeCompletion({ user: { ...user, avatarUrl: realAvatarUrl(user.avatarUrl) }, profile, documents: docs, skillsCount: profile ? profile.skills.length : 0, availabilityCount: profile ? profile.availabilities.filter((a) => a.isActive).length : 0 }),
      verification: {
        status,
        profileStatus: profile ? profile.verificationStatus : null,
        isVerified: Boolean(profile && profile.verificationStatus === 'VERIFIED'),
        reason: status === 'REJECTED' || status === 'RESUBMISSION_REQUIRED' ? onboarding.decisionReason : null,
        submittedAt: onboarding ? onboarding.submittedAt : null,
        documents: docs.map(formatDocument)
      },
      profession: profile ? {
        primary: profile.primaryCategory ? profile.primaryCategory.name : null,
        experienceYears: profile.experienceYears, city: profile.city, locality: profile.locality
      } : null,
      availability: {
        workingHours: profile ? profile.availabilities.filter((a) => a.isActive).sort((a, b) => a.dayOfWeek - b.dayOfWeek).map((a) => ({ dayOfWeek: a.dayOfWeek, startTime: a.startTime, endTime: a.endTime })) : [],
        liveAvailable: Boolean(location && location.isAvailable && location.sharingEnabled)
      },
      upcomingBookings: upcoming.map(bookingView),
      bookingRequests: requested.map(bookingView),
      jobRequests: { openMatchingCount: jobCount, recent: jobs.map((j) => ({ ...j, budgetMin: num(j.budgetMin), budgetMax: num(j.budgetMax) })) },
      earnings: { currency: earningsData.currency, payoutRail: earningsData.payoutRail, ...earningsData.summary },
      reviews: {
        count: reviewAgg._count, average: reviewAgg._count ? Math.round(num(reviewAgg._avg.rating) * 10) / 10 : null,
        recent: reviews.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, customerName: reviewService.reviewerLabel(r.customer && r.customer.name), createdAt: r.createdAt }))
      }
    });
  } catch (error) {
    sendError(res, error, 'loading dashboard');
  }
};


// ── Portfolio photographs (public images of past work) ──────────────────────

const MAX_PORTFOLIO = 12;
const portfolioView = (item) => ({ id: item.id, url: item.imageUrl, caption: item.caption || '', createdAt: item.createdAt });

// @route GET /api/worker/portfolio
exports.getPortfolio = async (req, res) => {
  try {
    const profile = await prisma.workerProfile.findUnique({ where: { userId: req.user.id }, include: { portfolio: { orderBy: { createdAt: 'desc' } } } });
    res.json({ success: true, max: MAX_PORTFOLIO, hasProfile: Boolean(profile), items: profile ? profile.portfolio.map(portfolioView) : [] });
  } catch (error) {
    sendError(res, error, 'loading portfolio');
  }
};

// @route POST /api/worker/portfolio   multipart: photo, caption
exports.addPortfolioItem = async (req, res) => {
  let uploaded = null;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No photo was uploaded.' });
    const profile = await prisma.workerProfile.findUnique({ where: { userId: req.user.id }, select: { id: true } });
    if (!profile) return res.status(409).json({ success: false, message: 'Complete the first onboarding steps before adding portfolio photos.' });
    const count = await prisma.workerPortfolioItem.count({ where: { workerProfileId: profile.id } });
    if (count >= MAX_PORTFOLIO) return res.status(400).json({ success: false, message: `You can keep up to ${MAX_PORTFOLIO} portfolio photos. Remove one first.` });

    uploaded = await publicImages.putPortfolioImage(req.user.id, req.file.buffer);
    const caption = typeof req.body.caption === 'string' ? req.body.caption.replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, 120) : '';
    const item = await prisma.workerPortfolioItem.create({
      data: { workerProfileId: profile.id, imageUrl: uploaded.url, storagePath: uploaded.path, caption: caption || null, sortOrder: count }
    });
    res.status(201).json({ success: true, item: portfolioView(item) });
  } catch (error) {
    if (uploaded) await publicImages.removePortfolioImage(uploaded.path);
    sendError(res, error, 'adding portfolio photo');
  }
};

// @route DELETE /api/worker/portfolio/:id
exports.deletePortfolioItem = async (req, res) => {
  try {
    const item = await prisma.workerPortfolioItem.findFirst({ where: { id: String(req.params.id), workerProfile: { userId: req.user.id } } });
    if (!item) return res.status(404).json({ success: false, message: 'Photo not found.' });
    await prisma.workerPortfolioItem.delete({ where: { id: item.id } });
    await publicImages.removePortfolioImage(item.storagePath);
    res.json({ success: true });
  } catch (error) {
    sendError(res, error, 'removing portfolio photo');
  }
};
