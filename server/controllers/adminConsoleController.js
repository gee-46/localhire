// Admin console API: dashboard, workers, customers, bookings, finance, categories, analytics, audit log.
// Every route here is mounted behind protect + authorize('Admin') (routes/adminRoutes.js).
//
// Principles:
//  * Read-only wherever possible. There is NO endpoint that changes a booking's or payment's state: those go through
//    the existing booking/payment rules (refunds and dispute resolution live in the payments panel).
//  * Suspending/reactivating needs a written reason and is audit-logged with actor, time, IP and reason. Reactivation
//    never touches identity verification: a worker still has to be approved through the document review workflow.
//  * Private identity documents never appear in these responses (only document type and review status).
//  * Customer contact details are masked in lists; opening a customer profile shows them and is itself audit-logged.
const prisma = require('../config/prisma');
const { disconnectUserSockets } = require('../trackingState');
const { parseRange, dateWhere } = require('../services/adminRange');
const finance = require('../services/adminFinance');
const analytics = require('../services/adminAnalytics');
const trackingService = require('../services/trackingService');
const publicImages = require('../services/publicImages');
const reviewService = require('../services/reviewService');

const FRESH_MS = 15 * 60 * 1000;
const ok = (res, body = {}) => res.json({ success: true, ...body });
const bad = (res, message, status = 400, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e && e.status && e.userMessage) return bad(res, e.userMessage, e.status);
    console.error('[Admin Console]', e);
    return res.status(500).json({ success: false, message: 'Server error while processing the admin request.' });
  }
};
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const paging = (q, def = 15, max = 50) => {
  const limit = Math.min(max, Math.max(1, parseInt(q.limit, 10) || def));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page, skip: (page - 1) * limit };
};
const pagesOf = (total, limit) => Math.max(1, Math.ceil(total / limit));
const esc = (s) => String(s || '').trim();
const like = (s) => ({ contains: esc(s).slice(0, 80), mode: 'insensitive' });
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return u && d ? `${u.slice(0, 1)}${'*'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}` : ''; };
const maskPhone = (p) => { const digits = String(p || '').replace(/\D/g, ''); return digits.length >= 4 ? `${'•'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : ''; };
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Customer';

const audit = (req, action, entityType, entityId, details) => prisma.auditLog.create({
  data: { userId: req.user.id, action, entityType, entityId: String(entityId), details: details || {}, ipAddress: req.ip || null, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null }
}).catch((e) => console.error('[Admin Console] audit write failed:', e.message));

const rangeOr400 = (req, res, opts) => { const r = parseRange(req.query, opts); if (r.error) { bad(res, r.error); return null; } return r; };

// ── Dashboard ────────────────────────────────────────────────────────────────

exports.dashboard = handle(async (req, res) => {
  const range = rangeOr400(req, res); if (!range) return;
  const bookingWhere = range.from || range.to ? { createdAt: dateWhere(range) } : {};
  const freshSince = new Date(Date.now() - FRESH_MS);
  const [customers, workers, suspendedUsers, verified, pendingVerifications, online, byStatus, journeyStarted, journeyArrived, money, openTickets] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER' } }),
    prisma.user.count({ where: { role: 'WORKER' } }),
    prisma.user.count({ where: { suspendedAt: { not: null }, isActive: false } }),
    prisma.workerProfile.count({ where: { verificationStatus: 'VERIFIED' } }),
    prisma.workerOnboarding.count({ where: { status: { in: ['PENDING', 'UNDER_REVIEW'] } } }),
    prisma.workerLocation.count({ where: { isAvailable: true, sharingEnabled: true, lastLocationUpdate: { gte: freshSince }, workerProfile: { verificationStatus: 'VERIFIED', user: { isActive: true } } } }),
    prisma.booking.groupBy({ by: ['status'], where: bookingWhere, _count: { id: true } }),
    prisma.booking.count({ where: { ...bookingWhere, status: 'DISPATCHED', arrivedAt: null } }),
    prisma.booking.count({ where: { ...bookingWhere, status: 'DISPATCHED', arrivedAt: { not: null } } }),
    finance.summarise(range),
    prisma.supportTicket.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } })
  ]);
  const by = Object.fromEntries(byStatus.map((g) => [g.status, g._count.id]));
  const g = (s) => by[s] || 0;
  const total = byStatus.reduce((a, x) => a + x._count.id, 0);
  ok(res, {
    range: { from: range.fromYmd, to: range.toYmd },
    users: { customers, workers, verifiedWorkers: verified, pendingVerifications, onlineWorkers: online, suspendedAccounts: suspendedUsers },
    bookings: {
      total, pending: g('REQUESTED'), active: g('CONFIRMED') + g('DISPATCHED') + g('IN_PROGRESS') + g('AWAITING_CUSTOMER_CONFIRMATION'),
      accepted: g('CONFIRMED'), journeyStarted, arrived: journeyArrived, inService: g('IN_PROGRESS'), completionRequested: g('AWAITING_CUSTOMER_CONFIRMATION'),
      completed: g('COMPLETED'), cancelled: g('CANCELLED'), disputed: g('DISPUTED')
    },
    openSupportTickets: openTickets,
    money: {
      grossServiceValue: money.grossServiceValue, commissionEarned: money.commission.earned, commissionPending: money.commission.pending, commissionRatePercent: money.commission.configuredRatePercent,
      refunds: money.refunds, taxesHeld: money.taxesNet, platformFeesNet: money.platformFeesNet, customerPaymentValue: money.customerPaymentValue, netCashReceived: money.netCashReceived,
      outstandingWorkerSettlements: money.workers.outstandingLiability, owedNotYetTransferred: money.workers.owedNotYetTransferred, actualWorkerPayouts: money.workers.actualPayoutsCompleted,
      failedPayouts: money.workers.failedPayouts, payoutMode: money.payouts.mode, payoutNote: money.payouts.note
    }
  });
});

// ── Finance ──────────────────────────────────────────────────────────────────

exports.financeSummary = handle(async (req, res) => {
  const range = rangeOr400(req, res); if (!range) return;
  ok(res, { finance: await finance.summarise(range) });
});
exports.financeOwed = handle(async (req, res) => ok(res, { workers: await finance.owedWorkers({ limit: parseInt(req.query.limit, 10) || 50 }) }));
exports.financeSettlements = handle(async (req, res) => {
  const range = rangeOr400(req, res); if (!range) return;
  const { page, limit } = paging(req.query);
  ok(res, await finance.listSettlements({ status: req.query.status, page, limit, range }));
});

// ── Analytics ────────────────────────────────────────────────────────────────

exports.analytics = handle(async (req, res) => {
  const range = rangeOr400(req, res, { defaultDays: 30 }); if (!range) return;
  const granularity = String(req.query.granularity || 'day') === 'month' ? 'month' : 'day';
  if (granularity === 'day' && range.days > 370) return bad(res, 'Daily charts cover at most 370 days. Choose monthly granularity for longer ranges.');
  ok(res, await analytics.report({ range: { ...range, fromYmd: range.fromYmd, toYmd: range.toYmd }, granularity }));
});

// ── Workers ──────────────────────────────────────────────────────────────────

const onlineWhere = () => ({ isAvailable: true, sharingEnabled: true, lastLocationUpdate: { gte: new Date(Date.now() - FRESH_MS) } });
const isOnline = (loc) => Boolean(loc && loc.isAvailable && loc.sharingEnabled && loc.lastLocationUpdate && Date.now() - new Date(loc.lastLocationUpdate).getTime() <= FRESH_MS);
const VERIFICATION = ['UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED'];

exports.listWorkers = handle(async (req, res) => {
  const { limit, page, skip } = paging(req.query);
  const q = esc(req.query.q);
  const profileWhere = {
    ...(req.query.categoryId ? { OR: [{ primaryCategoryId: String(req.query.categoryId) }, { additionalCategories: { some: { categoryId: String(req.query.categoryId) } } }] } : {}),
    ...(req.query.city ? { city: like(req.query.city) } : {}),
    ...(req.query.locality ? { locality: like(req.query.locality) } : {}),
    ...(VERIFICATION.includes(String(req.query.verification || '').toUpperCase()) ? { verificationStatus: String(req.query.verification).toUpperCase() } : {})
  };
  const availability = String(req.query.availability || '').toLowerCase();
  const where = {
    role: 'WORKER',
    ...(q ? { OR: [{ name: like(q) }, { email: like(q) }] } : {}),
    ...(req.query.status === 'suspended' ? { isActive: false } : req.query.status === 'active' ? { isActive: true } : {}),
    AND: [
      Object.keys(profileWhere).length ? { workerProfile: { is: profileWhere } } : {},
      availability === 'online' ? { workerProfile: { is: { locationSharing: { is: onlineWhere() } } } } : {},
      availability === 'offline' ? { NOT: { workerProfile: { is: { locationSharing: { is: onlineWhere() } } } } } : {}
    ]
  };
  const sort = { newest: { createdAt: 'desc' }, name: { name: 'asc' } }[req.query.sort] || { createdAt: 'desc' };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where, orderBy: sort, skip, take: limit,
      select: {
        id: true, name: true, email: true, isActive: true, suspendedAt: true, suspensionReason: true, createdAt: true,
        workerProfile: { select: { city: true, locality: true, verificationStatus: true, rating: true, reviewsCount: true, primaryCategory: { select: { id: true, name: true } }, locationSharing: { select: { isAvailable: true, sharingEnabled: true, lastLocationUpdate: true } } } }
      }
    })
  ]);
  const ids = rows.map((r) => r.id);
  const done = ids.length ? await prisma.booking.groupBy({ by: ['workerId'], where: { workerId: { in: ids }, status: 'COMPLETED' }, _count: { id: true } }) : [];
  const doneBy = new Map(done.map((d) => [d.workerId, d._count.id]));
  ok(res, {
    total, page, pages: pagesOf(total, limit),
    workers: rows.map((u) => {
      const p = u.workerProfile;
      return {
        id: u.id, name: u.name, email: u.email, profession: p && p.primaryCategory ? p.primaryCategory.name : null, city: p ? p.city : null, locality: p ? p.locality : null,
        verificationStatus: p ? p.verificationStatus : 'UNVERIFIED', online: isOnline(p && p.locationSharing), isActive: u.isActive, suspended: Boolean(u.suspendedAt) || !u.isActive,
        rating: p && p.reviewsCount > 0 ? Number(p.rating) : null, reviewsCount: p ? p.reviewsCount : 0, completedJobs: doneBy.get(u.id) || 0, joinedAt: u.createdAt
      };
    })
  });
});

exports.getWorker = handle(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true, name: true, email: true, phone: true, role: true, avatarUrl: true, isActive: true, createdAt: true, suspendedAt: true, suspensionReason: true, suspendedById: true,
      workerProfile: {
        select: {
          id: true, bio: true, experienceYears: true, city: true, locality: true, hourlyRate: true, inspectionFee: true, verificationStatus: true, rating: true, reviewsCount: true,
          primaryCategory: { select: { id: true, name: true } }, additionalCategories: { select: { category: { select: { name: true } } } }, skills: { select: { skillName: true } },
          locationSharing: { select: { isAvailable: true, sharingEnabled: true, lastLocationUpdate: true } }
        }
      },
      workerOnboarding: { select: { id: true, status: true, submittedAt: true, reviewedAt: true, decisionReason: true, attemptCount: true } }
    }
  });
  if (!user || user.role !== 'WORKER') return bad(res, 'Worker not found.', 404);
  const onboardingId = user.workerOnboarding && user.workerOnboarding.id;
  const [byStatus, reviews, events, documents, recent, earnings, tickets] = await Promise.all([
    prisma.booking.groupBy({ by: ['status'], where: { workerId: user.id }, _count: { id: true } }),
    prisma.review.findMany({ where: { workerId: user.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, rating: true, comment: true, createdAt: true, customer: { select: { name: true } }, booking: { select: { bookingNumber: true } } } }),
    onboardingId ? prisma.workerVerificationEvent.findMany({ where: { onboardingId }, orderBy: { createdAt: 'desc' }, take: 50 }) : [],
    // Document TYPE and REVIEW STATUS only: no file names, storage paths or links (those are served by the dedicated admin-only document route)
    onboardingId ? prisma.workerDocument.findMany({ where: { onboardingId }, select: { type: true, status: true, rejectionReason: true, createdAt: true } }) : [],
    prisma.booking.findMany({ where: { workerId: user.id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, bookingNumber: true, status: true, agreedPrice: true, scheduledAt: true, customer: { select: { name: true } } } }),
    prisma.workerSettlement.groupBy({ by: ['status'], where: { workerId: user.id }, _sum: { netAmount: true } }),
    prisma.supportTicket.findMany({ where: { booking: { workerId: user.id } }, orderBy: { createdAt: 'desc' }, take: 10, select: { ticketNumber: true, subject: true, status: true, priority: true, createdAt: true } })
  ]);
  const by = Object.fromEntries(byStatus.map((g) => [g.status, g._count.id]));
  const earn = Object.fromEntries(earnings.map((e) => [e.status, num(e._sum.netAmount)]));
  const p = user.workerProfile;
  ok(res, {
    worker: {
      id: user.id, name: user.name, email: user.email, phone: user.phone, avatarUrl: user.avatarUrl, joinedAt: user.createdAt,
      isActive: user.isActive, suspended: !user.isActive, suspendedAt: user.suspendedAt, suspensionReason: user.suspensionReason,
      profile: p ? {
        profession: p.primaryCategory ? p.primaryCategory.name : null, additionalCategories: p.additionalCategories.map((c) => c.category.name), skills: p.skills.map((s) => s.skillName),
        bio: p.bio, experienceYears: p.experienceYears, city: p.city, locality: p.locality, hourlyRate: num(p.hourlyRate), inspectionFee: num(p.inspectionFee),
        rating: p.reviewsCount > 0 ? Number(p.rating) : null, reviewsCount: p.reviewsCount, online: isOnline(p.locationSharing)
      } : null,
      verification: {
        status: p ? p.verificationStatus : 'UNVERIFIED', onboardingStatus: user.workerOnboarding ? user.workerOnboarding.status : null,
        submittedAt: user.workerOnboarding ? user.workerOnboarding.submittedAt : null, reviewedAt: user.workerOnboarding ? user.workerOnboarding.reviewedAt : null, decisionReason: user.workerOnboarding ? user.workerOnboarding.decisionReason : null,
        attempts: user.workerOnboarding ? user.workerOnboarding.attemptCount : 0,
        documents, history: events.map((e) => ({ action: e.action, actorRole: e.actorRole, fromStatus: e.fromStatus, toStatus: e.toStatus, reason: e.reason, at: e.createdAt })),
        reviewLink: `/pages/admin.html#worker-verification-card`
      },
      stats: { bookingsByStatus: by, completedJobs: by.COMPLETED || 0, totalBookings: Object.values(by).reduce((a, b) => a + b, 0) },
      earnings: { owedNotYetTransferred: earn.ELIGIBLE || 0, pending: (earn.PENDING_COMPLETION || 0) + (earn.BLOCKED || 0), processing: earn.PAYOUT_PROCESSING || 0, paidOut: earn.PAID || 0, failed: earn.FAILED || 0 },
      reviews: reviews.map((r) => ({ id: r.id, status: r.status, rating: r.rating, comment: r.comment, customer: firstName(r.customer.name), bookingNumber: r.booking.bookingNumber, at: r.createdAt })),
      recentBookings: recent.map((b) => ({ id: b.id, bookingNumber: b.bookingNumber, status: b.status, price: num(b.agreedPrice), scheduledAt: b.scheduledAt, customer: firstName(b.customer.name) })),
      complaints: tickets
    }
  });
});

// Suspend / reactivate (workers and customers). Reason required; audit-logged; never alters identity verification.
const setSuspension = (role, suspend) => handle(async (req, res) => {
  const reason = esc(req.body && req.body.reason);
  if (reason.length < 5 || reason.length > 500) return bad(res, 'A reason of 5 to 500 characters is required.');
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, role: true, isActive: true, name: true, suspendedAt: true } });
  if (!user || user.role !== role) return bad(res, `${role === 'WORKER' ? 'Worker' : 'Customer'} not found.`, 404);
  if (user.id === req.user.id) return bad(res, 'You cannot change your own account status.', 403);
  if (suspend && !user.isActive) return bad(res, 'This account is already suspended.', 409);
  if (!suspend && user.isActive) return bad(res, 'This account is not suspended.', 409);

  if (suspend) {
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false, suspendedAt: new Date(), suspensionReason: reason, suspendedById: req.user.id, tokenVersion: { increment: 1 } } });
    if (role === 'WORKER') {
      // off the marketplace immediately; their own sessions end
      await prisma.workerLocation.updateMany({ where: { workerProfile: { userId: user.id } }, data: { isAvailable: false, sharingEnabled: false, latitude: null, longitude: null, lastLocationUpdate: null, accuracyMeters: null } });
    }
    disconnectUserSockets(user.id);
  } else {
    // identity verification is NOT touched: a worker approved or not before stays exactly that
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true, suspendedAt: null, suspensionReason: null, suspendedById: null } });
  }
  const open = await prisma.booking.count({ where: { [role === 'WORKER' ? 'workerId' : 'customerId']: user.id, status: { in: ['REQUESTED', 'CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'] } } });
  await audit(req, suspend ? `${role}_SUSPENDED` : `${role}_REACTIVATED`, 'USER', user.id, { reason, subject: user.name, openBookings: open });
  ok(res, { message: suspend ? 'Account suspended.' : 'Account reactivated.', openBookings: open, note: open && suspend ? 'This account still has open bookings. Handle them through the normal booking, refund and dispute process.' : undefined });
});
exports.suspendWorker = setSuspension('WORKER', true);
exports.reactivateWorker = setSuspension('WORKER', false);
exports.suspendCustomer = setSuspension('CUSTOMER', true);
exports.reactivateCustomer = setSuspension('CUSTOMER', false);

// ── Customers ────────────────────────────────────────────────────────────────

exports.listCustomers = handle(async (req, res) => {
  const { limit, page, skip } = paging(req.query);
  const q = esc(req.query.q);
  const where = {
    role: 'CUSTOMER',
    ...(q ? { OR: [{ name: like(q) }, { email: like(q) }] } : {}),
    ...(req.query.status === 'suspended' ? { isActive: false } : req.query.status === 'active' ? { isActive: true } : {})
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, select: { id: true, name: true, email: true, phone: true, isActive: true, suspendedAt: true, createdAt: true } })
  ]);
  const ids = rows.map((r) => r.id);
  const counts = ids.length ? await prisma.booking.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { id: true } }) : [];
  const cb = new Map(counts.map((c) => [c.customerId, c._count.id]));
  ok(res, {
    total, page, pages: pagesOf(total, limit),
    customers: rows.map((u) => ({ id: u.id, name: u.name, email: maskEmail(u.email), phone: maskPhone(u.phone), isActive: u.isActive, suspended: !u.isActive, bookings: cb.get(u.id) || 0, joinedAt: u.createdAt }))
  });
});

exports.getCustomer = handle(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, createdAt: true, suspendedAt: true, suspensionReason: true } });
  if (!user || user.role !== 'CUSTOMER') return bad(res, 'Customer not found.', 404);
  const [bookings, payments, tickets, byStatus] = await Promise.all([
    prisma.booking.findMany({ where: { customerId: user.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, bookingNumber: true, status: true, agreedPrice: true, scheduledAt: true, createdAt: true, worker: { select: { name: true } }, address: { select: { city: true } }, payment: { select: { state: true } } } }),
    prisma.payment.findMany({ where: { customerId: user.id, state: { not: 'CREATED' } }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, paymentNumber: true, totalAmount: true, amountRefunded: true, state: true, method: true, capturedAt: true, createdAt: true, disputed: true, booking: { select: { bookingNumber: true } } } }),
    prisma.supportTicket.findMany({ where: { OR: [{ reporterId: user.id }, { booking: { customerId: user.id } }] }, orderBy: { createdAt: 'desc' }, take: 20, select: { ticketNumber: true, subject: true, status: true, priority: true, createdAt: true, booking: { select: { bookingNumber: true } } } }),
    prisma.booking.groupBy({ by: ['status'], where: { customerId: user.id }, _count: { id: true } })
  ]);
  // contact details are shown here, so opening a profile is recorded
  await audit(req, 'CUSTOMER_PROFILE_VIEWED', 'USER', user.id, { fields: ['email', 'phone'] });
  const by = Object.fromEntries(byStatus.map((g) => [g.status, g._count.id]));
  ok(res, {
    customer: {
      id: user.id, name: user.name, email: user.email, phone: user.phone, joinedAt: user.createdAt, isActive: user.isActive, suspended: !user.isActive, suspendedAt: user.suspendedAt, suspensionReason: user.suspensionReason,
      stats: { bookingsByStatus: by, totalBookings: Object.values(by).reduce((a, b) => a + b, 0), totalPaid: payments.filter((p) => ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.state)).reduce((a, p) => a + num(p.totalAmount), 0), totalRefunded: payments.reduce((a, p) => a + num(p.amountRefunded), 0) },
      bookings: bookings.map((b) => ({ id: b.id, bookingNumber: b.bookingNumber, status: b.status, price: num(b.agreedPrice), scheduledAt: b.scheduledAt, worker: b.worker.name, city: b.address ? b.address.city : null, paymentState: b.payment ? b.payment.state : null })),
      payments: payments.map((p) => ({ paymentNumber: p.paymentNumber, bookingNumber: p.booking.bookingNumber, total: num(p.totalAmount), refunded: num(p.amountRefunded), state: p.state, method: p.method, at: p.capturedAt || p.createdAt, disputed: p.disputed })),
      complaints: tickets.map((t) => ({ ticketNumber: t.ticketNumber, subject: t.subject, status: t.status, priority: t.priority, bookingNumber: t.booking ? t.booking.bookingNumber : null, createdAt: t.createdAt }))
    }
  });
});

// ── Bookings (read-only) ─────────────────────────────────────────────────────

const BOOKING_FILTERS = {
  requested: { status: 'REQUESTED' },
  accepted: { status: 'CONFIRMED' },
  active: { status: { in: ['CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'] } },
  journey_started: { status: 'DISPATCHED', arrivedAt: null },
  arrived: { status: 'DISPATCHED', arrivedAt: { not: null } },
  in_service: { status: 'IN_PROGRESS' },
  completion_requested: { status: 'AWAITING_CUSTOMER_CONFIRMATION' },
  completed: { status: 'COMPLETED' },
  cancelled: { status: 'CANCELLED' },
  disputed: { status: 'DISPUTED' }
};

exports.listBookings = handle(async (req, res) => {
  const range = rangeOr400(req, res); if (!range) return;
  const { limit, page, skip } = paging(req.query);
  const f = String(req.query.status || '').toLowerCase();
  if (f && !BOOKING_FILTERS[f]) return bad(res, `Unknown status filter. Use one of: ${Object.keys(BOOKING_FILTERS).join(', ')}.`);
  const q = esc(req.query.q);
  const where = {
    ...(f ? BOOKING_FILTERS[f] : {}),
    ...(range.from || range.to ? { createdAt: dateWhere(range) } : {}),
    ...(q ? { OR: [{ bookingNumber: like(q) }, { customer: { name: like(q) } }, { worker: { name: like(q) } }] } : {})
  };
  const [total, rows] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take: limit,
      select: {
        id: true, bookingNumber: true, status: true, arrivedAt: true, agreedPrice: true, scheduledAt: true, createdAt: true,
        customer: { select: { name: true } }, worker: { select: { name: true } }, serviceItem: { select: { title: true } }, problemDescription: true,
        payment: { select: { state: true, totalAmount: true, amountRefunded: true, disputed: true, settlement: { select: { status: true } } } }
      }
    })
  ]);
  ok(res, {
    total, page, pages: pagesOf(total, limit), filters: Object.keys(BOOKING_FILTERS),
    bookings: rows.map((b) => ({
      id: b.id, bookingNumber: b.bookingNumber, status: b.status, journeyStatus: trackingService.journeyStatus(b), customer: b.customer.name, worker: b.worker.name,
      service: (b.serviceItem && b.serviceItem.title) || String(b.problemDescription || '').slice(0, 60) || 'Service booking', price: num(b.agreedPrice), scheduledAt: b.scheduledAt, createdAt: b.createdAt,
      payment: b.payment ? { state: b.payment.state, total: num(b.payment.totalAmount), refunded: num(b.payment.amountRefunded), disputed: b.payment.disputed, settlement: b.payment.settlement ? b.payment.settlement.status : null } : null
    }))
  });
});

exports.getBooking = handle(async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true, bookingNumber: true, status: true, arrivedAt: true, journeyStartedAt: true, startedAt: true, completedAt: true, cancelledAt: true, cancellationReason: true, agreedPrice: true, priceConfirmedAt: true,
      scheduledAt: true, timeSlot: true, problemDescription: true, createdAt: true,
      customer: { select: { id: true, name: true } }, worker: { select: { id: true, name: true } }, serviceItem: { select: { title: true } }, address: { select: { city: true, postalCode: true } },
      statusHistory: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, reason: true, createdAt: true, changedById: true } },
      payment: { select: { paymentNumber: true, state: true, totalAmount: true, serviceAmount: true, platformFee: true, taxAmount: true, amountRefunded: true, method: true, capturedAt: true, disputed: true, disputeReason: true, refunds: { select: { amount: true, kind: true, status: true, createdAt: true } }, settlement: { select: { status: true, commission: true, netAmount: true, refundAdjustment: true, failureReason: true } } } }
    }
  });
  if (!b) return bad(res, 'Booking not found.', 404);
  const tickets = await prisma.supportTicket.findMany({ where: { bookingId: b.id }, select: { ticketNumber: true, subject: true, status: true, priority: true, createdAt: true } });
  const p = b.payment;
  ok(res, {
    booking: {
      id: b.id, bookingNumber: b.bookingNumber, status: b.status, journeyStatus: trackingService.journeyStatus(b), customer: b.customer, worker: b.worker, service: (b.serviceItem && b.serviceItem.title) || null,
      problemDescription: b.problemDescription, scheduledAt: b.scheduledAt, timeSlot: b.timeSlot, area: b.address ? `${b.address.city} ${b.address.postalCode}` : null,
      price: num(b.agreedPrice), priceConfirmedAt: b.priceConfirmedAt, createdAt: b.createdAt, journeyStartedAt: b.journeyStartedAt, arrivedAt: b.arrivedAt, startedAt: b.startedAt, completedAt: b.completedAt, cancelledAt: b.cancelledAt, cancellationReason: b.cancellationReason,
      history: b.statusHistory.map((h) => ({ from: h.fromStatus, to: h.toStatus, reason: h.reason, at: h.createdAt, by: h.changedById === b.customer.id ? 'Customer' : h.changedById === b.worker.id ? 'Professional' : (h.changedById ? 'Admin / system' : 'System') })),
      payment: p ? {
        paymentNumber: p.paymentNumber, state: p.state, total: num(p.totalAmount), service: num(p.serviceAmount), platformFee: num(p.platformFee), tax: num(p.taxAmount), refunded: num(p.amountRefunded), method: p.method, capturedAt: p.capturedAt, disputed: p.disputed, disputeReason: p.disputeReason,
        refunds: p.refunds.map((r) => ({ amount: num(r.amount), kind: r.kind, status: r.status, at: r.createdAt })),
        settlement: p.settlement ? { status: p.settlement.status, commission: num(p.settlement.commission), workerNet: num(p.settlement.netAmount), refundAdjustment: num(p.settlement.refundAdjustment), failureReason: p.settlement.status === 'FAILED' ? p.settlement.failureReason : null } : null
      } : null,
      complaints: tickets,
      actions: { note: 'Booking and payment states change only through the normal booking flow, refunds and dispute resolution (Payments panel). No state can be forced here.' }
    }
  });
});

// ── Categories ───────────────────────────────────────────────────────────────

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const cleanName = (v) => String(v || '').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();

const categoryCounts = async () => {
  const rows = await prisma.$queryRaw`
    SELECT c."id",
      (SELECT count(*)::int FROM "WorkerProfile" wp WHERE wp."primaryCategoryId" = c."id") AS workers,
      (SELECT count(*)::int FROM "ServiceItem" si WHERE si."categoryId" = c."id") AS services,
      (SELECT count(*)::int FROM "JobPost" jp WHERE jp."categoryId" = c."id") AS jobs,
      (SELECT count(*)::int FROM "Booking" b
         LEFT JOIN "ServiceItem" si ON si."id" = b."serviceItemId"
         LEFT JOIN "JobPost" jp ON jp."id" = b."jobPostId"
         LEFT JOIN "WorkerProfile" wp ON wp."userId" = b."workerId"
         WHERE coalesce(si."categoryId", jp."categoryId", wp."primaryCategoryId") = c."id") AS bookings
    FROM "ServiceCategory" c`;
  return new Map(rows.map((r) => [r.id, r]));
};
const categoryView = (c, counts) => ({
  id: c.id, name: c.name, slug: c.slug, description: c.description, iconUrl: c.iconUrl, displayOrder: c.displayOrder, isActive: c.isActive,
  counts: { workers: (counts && counts.workers) || 0, services: (counts && counts.services) || 0, jobs: (counts && counts.jobs) || 0, bookings: (counts && counts.bookings) || 0 }, updatedAt: c.updatedAt
});

exports.listCategories = handle(async (req, res) => {
  const [cats, counts] = await Promise.all([prisma.serviceCategory.findMany({ orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }), categoryCounts()]);
  ok(res, { categories: cats.map((c) => categoryView(c, counts.get(c.id))) });
});

exports.createCategory = handle(async (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (name.length < 2 || name.length > 60) return bad(res, 'Category name must be 2 to 60 characters.');
  const description = req.body && req.body.description ? String(req.body.description).trim().slice(0, 500) : null;
  const slug = slugify(name);
  if (!slug) return bad(res, 'Category name must contain letters or numbers.');
  const clash = await prisma.serviceCategory.findFirst({ where: { OR: [{ name: { equals: name, mode: 'insensitive' } }, { slug }] } });
  if (clash) return bad(res, 'A category with this name already exists.', 409);
  const max = await prisma.serviceCategory.aggregate({ _max: { displayOrder: true } });
  const cat = await prisma.serviceCategory.create({ data: { name, slug, description, displayOrder: Number.isFinite(Number(req.body.displayOrder)) ? Math.trunc(Number(req.body.displayOrder)) : (max._max.displayOrder || 0) + 1, isActive: req.body.isActive === false ? false : true } });
  await audit(req, 'CATEGORY_CREATED', 'SERVICE_CATEGORY', cat.id, { name, reason: esc(req.body.reason) || null });
  res.status(201).json({ success: true, category: categoryView(cat, null) });
});

exports.updateCategory = handle(async (req, res) => {
  const cat = await prisma.serviceCategory.findUnique({ where: { id: String(req.params.id) } });
  if (!cat) return bad(res, 'Category not found.', 404);
  const b = req.body || {}; const data = {}; const changes = {};
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    if (name.length < 2 || name.length > 60) return bad(res, 'Category name must be 2 to 60 characters.');
    const clash = await prisma.serviceCategory.findFirst({ where: { id: { not: cat.id }, name: { equals: name, mode: 'insensitive' } } });
    if (clash) return bad(res, 'Another category already has this name.', 409);
    if (name !== cat.name) { data.name = name; changes.name = { from: cat.name, to: name }; } // the slug stays stable so existing links keep working
  }
  if (b.description !== undefined) { data.description = b.description ? String(b.description).trim().slice(0, 500) : null; changes.description = true; }
  if (b.displayOrder !== undefined) {
    const n = Number(b.displayOrder); if (!Number.isFinite(n) || n < 0 || n > 10000) return bad(res, 'Display order must be a number between 0 and 10000.');
    data.displayOrder = Math.trunc(n); changes.displayOrder = data.displayOrder;
  }
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') return bad(res, 'isActive must be true or false.');
    if (b.isActive !== cat.isActive) {
      const reason = esc(b.reason);
      if (!b.isActive && reason.length < 5) return bad(res, 'A reason (at least 5 characters) is required to disable a category.');
      data.isActive = b.isActive; changes.isActive = { from: cat.isActive, to: b.isActive };
    }
  }
  if (!Object.keys(data).length) return bad(res, 'Nothing to change.');
  const updated = await prisma.serviceCategory.update({ where: { id: cat.id }, data });
  await audit(req, 'CATEGORY_UPDATED', 'SERVICE_CATEGORY', cat.id, { changes, reason: esc(b.reason) || null });
  const counts = await categoryCounts();
  ok(res, { category: categoryView(updated, counts.get(cat.id)) });
});

exports.uploadCategoryIcon = handle(async (req, res) => {
  const cat = await prisma.serviceCategory.findUnique({ where: { id: String(req.params.id) } });
  if (!cat) return bad(res, 'Category not found.', 404);
  if (!req.file) return bad(res, 'Choose an image file (JPG, PNG or WebP, up to 2 MB).');
  let uploaded;
  try { uploaded = await publicImages.putCategoryImage(cat.id, req.file.buffer); } catch (e) { return bad(res, e.message || 'Could not store the image.', e.status || 500); }
  const updated = await prisma.serviceCategory.update({ where: { id: cat.id }, data: { iconUrl: uploaded.url } });
  await audit(req, 'CATEGORY_ICON_UPDATED', 'SERVICE_CATEGORY', cat.id, { path: uploaded.path });
  ok(res, { category: categoryView(updated, null) });
});

exports.deleteCategory = handle(async (req, res) => {
  const cat = await prisma.serviceCategory.findUnique({ where: { id: String(req.params.id) } });
  if (!cat) return bad(res, 'Category not found.', 404);
  const counts = (await categoryCounts()).get(cat.id);
  const extra = await prisma.workerProfileCategory.count({ where: { categoryId: cat.id } });
  const used = counts.workers + counts.services + counts.jobs + counts.bookings + extra;
  if (used > 0) {
    return bad(res, 'This category is in use (professionals, services, job posts or bookings refer to it), so it cannot be deleted. Disable it instead: it is hidden from new use and history is kept.', 409, { counts: { ...counts, additionalWorkers: extra } });
  }
  await prisma.serviceCategory.delete({ where: { id: cat.id } });
  await audit(req, 'CATEGORY_DELETED', 'SERVICE_CATEGORY', cat.id, { name: cat.name, reason: esc(req.body && req.body.reason) || null });
  ok(res, { message: 'Category deleted.' });
});

// ── Audit log ────────────────────────────────────────────────────────────────

exports.auditLogs = handle(async (req, res) => {
  const { limit, page, skip } = paging(req.query, 20, 100);
  const range = rangeOr400(req, res); if (!range) return;
  const where = {
    ...(req.query.action ? { action: String(req.query.action).slice(0, 60) } : {}),
    ...(req.query.entityType ? { entityType: String(req.query.entityType).slice(0, 40) } : {}),
    ...(range.from || range.to ? { createdAt: dateWhere(range) } : {})
  };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit, include: { user: { select: { name: true, role: true } } } })
  ]);
  ok(res, { total, page, pages: pagesOf(total, limit), logs: rows.map((l) => ({ id: l.id, action: l.action, entityType: l.entityType, entityId: l.entityId, actor: l.user ? l.user.name : null, actorRole: l.user ? l.user.role : null, reason: l.details && l.details.reason ? l.details.reason : null, at: l.createdAt })) });
});

// ── Review moderation ──────────────────────────────────────────────────────
// Admins can read, hide and restore reviews and resolve reports. They can never edit or delete a review: the
// record, its reports and its moderation history are kept. Customers appear by name only (no contact details).

const REVIEW_STATES = ['PUBLISHED', 'REPORTED', 'HIDDEN'];
const reviewRow = (r) => {
  const open = r._count ? r._count.reports : 0;
  return {
    id: r.id, rating: r.rating, comment: r.comment, state: reviewService.stateOf(r, open), openReports: open,
    customer: r.customer ? r.customer.name : null, worker: r.worker ? { id: r.worker.id, name: r.worker.name } : null,
    bookingNumber: r.booking ? r.booking.bookingNumber : null, createdAt: r.createdAt, hiddenAt: r.hiddenAt || null
  };
};
const reviewInclude = { customer: { select: { name: true } }, worker: { select: { id: true, name: true } }, booking: { select: { bookingNumber: true } } };

exports.listReviews = handle(async (req, res) => {
  const { limit, page, skip } = paging(req.query);
  const state = String(req.query.state || '').toUpperCase();
  const q = esc(req.query.q);
  const rating = parseInt(req.query.rating, 10);
  const where = {
    ...(state === 'HIDDEN' ? { status: 'HIDDEN' } : state === 'PUBLISHED' ? { status: 'PUBLISHED', reports: { none: { status: 'OPEN' } } } : state === 'REPORTED' ? { status: 'PUBLISHED', reports: { some: { status: 'OPEN' } } } : {}),
    ...(rating >= 1 && rating <= 5 ? { rating } : {}),
    ...(q ? { OR: [{ comment: like(q) }, { worker: { name: like(q) } }, { customer: { name: like(q) } }, { booking: { bookingNumber: like(q) } }] } : {})
  };
  const [total, rows, counts] = await Promise.all([
    prisma.review.count({ where }),
    prisma.review.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take: limit, include: { ...reviewInclude, _count: { select: { reports: { where: { status: 'OPEN' } } } } } }),
    Promise.all([
      prisma.review.count({ where: { status: 'PUBLISHED', reports: { some: { status: 'OPEN' } } } }),
      prisma.review.count({ where: { status: 'HIDDEN' } }),
      prisma.review.count()
    ])
  ]);
  ok(res, { total, page, pages: pagesOf(total, limit), reviews: rows.map(reviewRow), counts: { reported: counts[0], hidden: counts[1], all: counts[2] } });
});

exports.getReview = handle(async (req, res) => {
  const r = await prisma.review.findUnique({
    where: { id: String(req.params.id) },
    include: {
      ...reviewInclude,
      booking: { select: { bookingNumber: true, status: true, scheduledAt: true, completedAt: true, agreedPrice: true, serviceItem: { select: { title: true } } } },
      reports: { orderBy: { createdAt: 'desc' }, include: { reporter: { select: { name: true } } } },
      moderationEvents: { orderBy: { createdAt: 'desc' }, include: { actor: { select: { name: true } } } }
    }
  });
  if (!r) return bad(res, 'Review not found.', 404);
  const open = r.reports.filter((x) => x.status === 'OPEN').length;
  ok(res, {
    review: {
      ...reviewRow({ ...r, _count: { reports: open } }),
      hiddenReason: r.hiddenReason || null,
      booking: { number: r.booking.bookingNumber, status: r.booking.status, service: r.booking.serviceItem ? r.booking.serviceItem.title : null, scheduledAt: r.booking.scheduledAt, completedAt: r.booking.completedAt, agreedPrice: num(r.booking.agreedPrice) },
      reports: r.reports.map((x) => ({ id: x.id, reporter: x.reporter ? x.reporter.name : null, reason: x.reason, details: x.details, status: x.status, createdAt: x.createdAt, resolvedAt: x.resolvedAt, resolutionNote: x.resolutionNote })),
      history: r.moderationEvents.map((e) => ({ id: e.id, action: e.action, actor: e.actor ? e.actor.name : null, reason: e.reason, at: e.createdAt }))
    }
  });
});

const moderation = (action, auditAction, message) => handle(async (req, res) => {
  const out = await reviewService.moderate({ action, reviewId: req.params.id, actor: req.user, reason: req.body && req.body.reason });
  await audit(req, auditAction, 'REVIEW', req.params.id, { reason: reviewService.cleanText(req.body && req.body.reason), workerId: out.workerId, reportsResolved: out.reportsResolved, workerRatingAfter: out.rating });
  ok(res, { message, reportsResolved: out.reportsResolved, workerRating: out.rating });
});
exports.hideReview = moderation('hide', 'REVIEW_HIDDEN', 'Review hidden. It no longer counts towards the professional’s rating.');
exports.restoreReview = moderation('restore', 'REVIEW_RESTORED', 'Review restored. It counts towards the professional’s rating again.');
exports.dismissReviewReports = moderation('dismiss', 'REVIEW_REPORTS_DISMISSED', 'Reports dismissed. The review stays published.');
