// Customer marketplace data for the homepage and the search box.
// Everything returned is read from real records. Sections with no real data come back empty so the UI
// can hide them; nothing is invented to fill space.
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { parseDiscoveryQuery, buildConditions } = require('../services/workerDiscovery');
const { realAvatarUrl } = require('../services/avatar');

const escapeLike = (value) => `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;

const FROM = Prisma.sql`FROM "WorkerLocation" wl
  JOIN "WorkerProfile" wp ON wp."id" = wl."workerProfileId"
  JOIN "User" u ON u."id" = wp."userId"
  JOIN "ServiceCategory" sc ON sc."id" = wp."primaryCategoryId"`;

// @desc    Homepage data: categories (with live availability counts), popular services, "book again"
// @route   GET /api/marketplace/home?lat=&lng=&radiusKm=
// @access  Public (optional auth personalises "book again")
exports.getHome = async (req, res) => {
  try {
    const parsed = parseDiscoveryQuery({ lat: req.query.lat, lng: req.query.lng, radiusKm: req.query.radiusKm });
    if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
    const p = parsed.params;

    const categories = await prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, slug: true, description: true, iconUrl: true }
    });

    // Workers a customer could actually find right now (verified + available [+ within radius]) per category,
    // counting both a worker's primary and additional categories once each.
    const where = Prisma.join(buildConditions({ ...p, category: null, tokens: [] }), ' AND ');
    const counts = await prisma.$queryRaw`
      WITH eligible AS (SELECT wp."id" AS pid, wp."primaryCategoryId" AS cid ${FROM} WHERE ${where})
      SELECT t.cid AS "categoryId", count(*)::int AS "workers" FROM (
        SELECT pid, cid FROM eligible
        UNION
        SELECT e.pid, wpc."categoryId" FROM eligible e JOIN "WorkerProfileCategory" wpc ON wpc."workerProfileId" = e.pid
      ) t GROUP BY t.cid`;
    const countByCategory = new Map(counts.map((row) => [row.categoryId, row.workers]));
    const withCounts = categories.map((c) => ({ ...c, availableWorkers: countByCategory.get(c.id) || 0 }));

    // Popular services = the catalog items customers have actually booked. If nothing has been booked yet, return
    // the plain catalog and say so, so the UI never presents catalog entries as "popular".
    const grouped = await prisma.booking.groupBy({
      by: ['serviceItemId'],
      where: { serviceItemId: { not: null }, status: { not: 'CANCELLED' } },
      _count: { _all: true },
      orderBy: { _count: { serviceItemId: 'desc' } },
      take: 8
    });
    let services = [];
    let servicesSource = 'popular';
    if (grouped.length) {
      const items = await prisma.serviceItem.findMany({
        where: { id: { in: grouped.map((g) => g.serviceItemId) }, isActive: true, category: { isActive: true } },
        include: { category: { select: { id: true, name: true, slug: true } } }
      });
      const order = new Map(grouped.map((g, i) => [g.serviceItemId, { i, bookings: g._count._all }]));
      services = items.sort((a, b) => order.get(a.id).i - order.get(b.id).i).map((s) => ({ ...serviceView(s), bookings: order.get(s.id).bookings }));
    }
    if (!services.length) {
      servicesSource = 'catalog';
      const items = await prisma.serviceItem.findMany({
        where: { isActive: true, category: { isActive: true } },
        include: { category: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ category: { displayOrder: 'asc' } }, { title: 'asc' }],
        take: 8
      });
      services = items.map(serviceView);
    }

    // "Book again": categories this customer has booked before (only real history, only for a logged-in customer).
    let bookAgain = [];
    if (req.user && req.user.role === 'Customer') {
      const history = await prisma.booking.findMany({
        where: { customerId: req.user.id, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { createdAt: true, worker: { select: { workerProfile: { select: { primaryCategory: { select: { id: true, name: true, slug: true } } } } } } }
      });
      const seen = new Map();
      for (const b of history) {
        const cat = b.worker && b.worker.workerProfile && b.worker.workerProfile.primaryCategory;
        if (!cat) continue;
        const entry = seen.get(cat.id) || { category: cat, times: 0, lastBookedAt: b.createdAt };
        entry.times += 1;
        seen.set(cat.id, entry);
      }
      bookAgain = [...seen.values()].slice(0, 6).map((e) => ({ ...e, availableWorkers: countByCategory.get(e.category.id) || 0 }));
    }

    res.json({ success: true, locationApplied: p.lat !== null, categories: withCounts, services, servicesSource, bookAgain });
  } catch (error) {
    console.error('[Marketplace Controller] getHome error:', error);
    res.status(500).json({ success: false, message: 'Could not load the marketplace right now.' });
  }
};

const serviceView = (s) => ({
  id: s.id, title: s.title, description: s.description || '', basePrice: Number(s.basePrice), priceType: s.priceType,
  durationMinutes: s.durationMinutes, category: s.category
});

// @desc    Typeahead: matching categories, catalog services and (approved) workers
// @route   GET /api/marketplace/suggest?q=
// @access  Public
exports.suggest = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return res.json({ success: true, categories: [], services: [], workers: [] });
    const like = escapeLike(q);

    const [categories, services, workers] = await Promise.all([
      prisma.$queryRaw`SELECT "id", "name", "slug" FROM "ServiceCategory" WHERE "isActive" = true AND ("name" ILIKE ${like} OR "slug" ILIKE ${like} OR "description" ILIKE ${like}) ORDER BY "displayOrder", "name" LIMIT 5`,
      prisma.serviceItem.findMany({
        where: { isActive: true, category: { isActive: true }, OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] },
        include: { category: { select: { id: true, name: true, slug: true } } },
        take: 5
      }),
      prisma.user.findMany({
        where: {
          role: 'WORKER', isActive: true,
          workerProfile: { is: { verificationStatus: 'VERIFIED' } },
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { workerProfile: { is: { skills: { some: { skillName: { contains: q, mode: 'insensitive' } } } } } }
          ]
        },
        include: { workerProfile: { select: { reviewsCount: true, rating: true, primaryCategory: { select: { name: true, slug: true } }, locationSharing: { select: { isAvailable: true, sharingEnabled: true, lastLocationUpdate: true } } } } },
        take: 5
      })
    ]);

    res.json({
      success: true,
      categories,
      services: services.map((s) => ({ id: s.id, title: s.title, category: s.category })),
      workers: workers.map((w) => {
        const sharing = w.workerProfile.locationSharing;
        return {
          id: w.id, name: w.name, avatarUrl: realAvatarUrl(w.avatarUrl),
          category: w.workerProfile.primaryCategory.name,
          rating: w.workerProfile.reviewsCount > 0 ? Number(w.workerProfile.rating) : null,
          reviewsCount: w.workerProfile.reviewsCount,
          availableNow: Boolean(sharing && sharing.isAvailable && sharing.sharingEnabled && sharing.lastLocationUpdate
            && Date.now() - new Date(sharing.lastLocationUpdate).getTime() <= 15 * 60 * 1000)
        };
      })
    });
  } catch (error) {
    console.error('[Marketplace Controller] suggest error:', error);
    res.status(500).json({ success: false, message: 'Search suggestions are unavailable right now.' });
  }
};
