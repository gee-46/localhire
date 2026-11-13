// Customer-facing worker discovery. One SQL query applies EVERY rule on the backend so the UI can never
// show (or be tricked into showing) a worker who is not eligible:
//   approved identity verification + active account + live availability (shared, fresh location),
// then the customer's filters and sort. Nothing here fabricates data: rating/price/experience are stored values.
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');

const FRESH_MS = 15 * 60 * 1000;
const SORTS = ['nearest', 'rating', 'price', 'experience'];
const AVAILABILITY = ['any', 'today', 'now'];
const MAX_LIMIT = 100;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// The price a customer is quoted up front: hourly rate, else the visit/starting charge.
const EFFECTIVE_PRICE = Prisma.sql`COALESCE(NULLIF(wp."hourlyRate", 0), NULLIF(wp."inspectionFee", 0))`;

const escapeLike = (value) => `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;

const toNum = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

// Validates raw query-string values. Returns { error } or { params }.
const parseDiscoveryQuery = (query = {}) => {
  const lat = toNum(query.lat);
  const lng = toNum(query.lng);
  const hasLat = lat !== null;
  const hasLng = lng !== null;
  if (hasLat !== hasLng) return { error: 'Latitude and longitude must be supplied together.' };
  if ((hasLat && (!Number.isFinite(lat) || lat < -90 || lat > 90)) || (hasLng && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
    return { error: 'Latitude or longitude is out of range.' };
  }

  const radiusInput = query.maxDistanceKm ?? query.radiusKm;
  const radiusKm = radiusInput === undefined || radiusInput === '' ? 20 : Number(radiusInput);
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 100) return { error: 'Search radius must be between 1 and 100 km.' };

  const maxPrice = toNum(query.maxPrice);
  if (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 0)) return { error: 'Maximum price must be a non-negative number.' };

  const minRating = toNum(query.minRating);
  if (minRating !== null && (!Number.isFinite(minRating) || minRating < 0 || minRating > 5)) return { error: 'Minimum rating must be between 0 and 5.' };

  const minExperience = toNum(query.minExperience);
  if (minExperience !== null && (!Number.isFinite(minExperience) || minExperience < 0 || minExperience > 60)) return { error: 'Minimum experience must be between 0 and 60 years.' };

  const availability = String(query.availability || 'any').toLowerCase();
  if (!AVAILABILITY.includes(availability)) return { error: `availability must be one of ${AVAILABILITY.join(', ')}.` };
  let day = null;
  let time = null;
  if (availability !== 'any') {
    day = toNum(query.day);
    time = String(query.time || '');
    if (!Number.isInteger(day) || day < 0 || day > 6) return { error: 'day (0-6) is required for an availability filter.' };
    if (availability === 'now' && !TIME_RE.test(time)) return { error: 'time (HH:MM) is required for the "open now" filter.' };
  }

  const sort = String(query.sort || (hasLat ? 'nearest' : 'rating')).toLowerCase();
  if (!SORTS.includes(sort)) return { error: `sort must be one of ${SORTS.join(', ')}.` };
  if (sort === 'nearest' && !hasLat) return { error: 'Sorting by distance needs a location (lat and lng).' };

  const limit = query.limit === undefined || query.limit === '' ? MAX_LIMIT : Number(query.limit);
  const page = query.page === undefined || query.page === '' ? 1 : Number(query.page);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `limit must be between 1 and ${MAX_LIMIT}.` };
  if (!Number.isInteger(page) || page < 1) return { error: 'page must be 1 or greater.' };

  const q = String(query.q || '').trim().slice(0, 80);
  const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5) : [];
  const category = String(query.category || '').trim().slice(0, 80) || null;
  const reviewedOnly = ['1', 'true', 'yes'].includes(String(query.reviewedOnly || '').toLowerCase());

  return {
    params: { lat: hasLat ? lat : null, lng: hasLng ? lng : null, radiusKm, maxPrice, minRating, minExperience, availability, day, time, sort, limit, page, tokens, category, reviewedOnly }
  };
};

const tokenCondition = (token) => {
  const like = escapeLike(token);
  return Prisma.sql`(
    u."name" ILIKE ${like} OR sc."name" ILIKE ${like} OR wp."bio" ILIKE ${like}
    OR EXISTS (SELECT 1 FROM "ProfessionalSkill" ps WHERE ps."workerProfileId" = wp."id" AND ps."skillName" ILIKE ${like})
    OR EXISTS (SELECT 1 FROM "WorkerProfileCategory" wpc JOIN "ServiceCategory" xc ON xc."id" = wpc."categoryId"
               WHERE wpc."workerProfileId" = wp."id" AND xc."name" ILIKE ${like})
    OR EXISTS (SELECT 1 FROM "ServiceItem" si
               WHERE si."isActive" = true AND (si."title" ILIKE ${like} OR si."description" ILIKE ${like})
                 AND (si."categoryId" = wp."primaryCategoryId"
                      OR EXISTS (SELECT 1 FROM "WorkerProfileCategory" wpc2 WHERE wpc2."workerProfileId" = wp."id" AND wpc2."categoryId" = si."categoryId")))
  )`;
};

const buildConditions = (p, now = new Date()) => {
  const freshSince = new Date(now.getTime() - FRESH_MS);
  const c = [
    Prisma.sql`wl."isAvailable" = true`,
    Prisma.sql`wl."sharingEnabled" = true`,
    Prisma.sql`wl."lastLocationUpdate" >= ${freshSince}`,
    Prisma.sql`u."isActive" = true`,
    Prisma.sql`u."role" = 'WORKER'`,
    Prisma.sql`wp."verificationStatus" = 'VERIFIED'` // approved identity verification: non-negotiable
  ];
  if (p.lat !== null) {
    c.push(Prisma.sql`wl."location" IS NOT NULL`);
    c.push(Prisma.sql`ST_DWithin(wl."location", ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography, ${p.radiusKm * 1000})`);
  }
  if (p.category) {
    const cat = p.category.toLowerCase();
    c.push(Prisma.sql`(lower(sc."name") = ${cat} OR sc."slug" = ${cat}
      OR EXISTS (SELECT 1 FROM "WorkerProfileCategory" wpc JOIN "ServiceCategory" xc ON xc."id" = wpc."categoryId"
                 WHERE wpc."workerProfileId" = wp."id" AND (lower(xc."name") = ${cat} OR xc."slug" = ${cat})))`);
  }
  if (p.maxPrice !== null) c.push(Prisma.sql`${EFFECTIVE_PRICE} <= ${p.maxPrice}`);
  if (p.minRating !== null && p.minRating > 0) c.push(Prisma.sql`(wp."reviewsCount" > 0 AND wp."rating" >= ${p.minRating})`);
  if (p.reviewedOnly) c.push(Prisma.sql`wp."reviewsCount" > 0`);
  if (p.minExperience !== null && p.minExperience > 0) c.push(Prisma.sql`wp."experienceYears" >= ${p.minExperience}`);
  if (p.availability === 'today') {
    c.push(Prisma.sql`EXISTS (SELECT 1 FROM "ProfessionalAvailability" pa WHERE pa."workerProfileId" = wp."id" AND pa."isActive" = true AND pa."dayOfWeek" = ${p.day})`);
  } else if (p.availability === 'now') {
    c.push(Prisma.sql`EXISTS (SELECT 1 FROM "ProfessionalAvailability" pa WHERE pa."workerProfileId" = wp."id" AND pa."isActive" = true
      AND pa."dayOfWeek" = ${p.day} AND pa."startTime" <= ${p.time} AND pa."endTime" > ${p.time})`);
  }
  p.tokens.forEach((t) => c.push(tokenCondition(t)));
  return c;
};

const orderBy = (p) => {
  if (p.sort === 'nearest') return Prisma.sql`"distanceKm" ASC, wp."id" ASC`;
  if (p.sort === 'price') return Prisma.sql`${EFFECTIVE_PRICE} ASC NULLS LAST, wp."id" ASC`;
  if (p.sort === 'experience') return Prisma.sql`wp."experienceYears" DESC, wp."id" ASC`;
  // rating: workers with real reviews first, best average then most reviews
  return Prisma.sql`(wp."reviewsCount" > 0) DESC, wp."rating" DESC, wp."reviewsCount" DESC, wp."id" ASC`;
};

const FROM = Prisma.sql`FROM "WorkerLocation" wl
  JOIN "WorkerProfile" wp ON wp."id" = wl."workerProfileId"
  JOIN "User" u ON u."id" = wp."userId"
  JOIN "ServiceCategory" sc ON sc."id" = wp."primaryCategoryId"`;

// Returns { total, rows: [{ workerProfileId, distanceKm }] } already ordered and paged. Worker coordinates are deliberately not selected.
const discover = async (p) => {
  const where = Prisma.join(buildConditions(p), ' AND ');
  const distance = p.lat !== null
    ? Prisma.sql`ST_Distance(wl."location", ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography) / 1000.0`
    : Prisma.sql`NULL::double precision`;
  const [countRow] = await prisma.$queryRaw`SELECT count(*)::int AS "total" ${FROM} WHERE ${where}`;
  const rows = await prisma.$queryRaw`
    SELECT wp."id" AS "workerProfileId", ${distance} AS "distanceKm"
    ${FROM} WHERE ${where}
    ORDER BY ${orderBy(p)}
    LIMIT ${p.limit} OFFSET ${(p.page - 1) * p.limit}`;
  return { total: countRow && Number.isFinite(countRow.total) ? countRow.total : rows.length, rows };
};

// Coarse distance for customers: rounded UP to the nearest 0.5 km so repeated queries from different points
// cannot be used to triangulate a worker's position.
const approximateDistanceKm = (km) => (km === null || km === undefined ? null : Math.max(0.5, Math.ceil(Number(km) * 2) / 2));

module.exports = { parseDiscoveryQuery, discover, approximateDistanceKm, buildConditions, EFFECTIVE_PRICE, FRESH_MS };
