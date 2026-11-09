// Admin analytics: accurate SQL over real records, bucketed by calendar day/month in the business time zone and
// zero-filled so charts have no gaps. Nothing is estimated or generated.
const prisma = require('../config/prisma');
const { timeZone } = require('./adminRange');

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

const report = async ({ range, granularity = 'day' }) => {
  const tz = timeZone();
  const month = granularity === 'month';
  const from = range.fromYmd; const to = range.toYmd;
  const bucketLabel = month ? 'YYYY-MM' : 'YYYY-MM-DD';
  const step = month ? '1 month' : '1 day';
  const trunc = month ? 'month' : 'day';

  // generate_series spine of buckets (local dates), formatted as text keys
  const spineRows = await prisma.$queryRawUnsafe(
    `SELECT to_char(g::date, '${bucketLabel}') AS bucket FROM generate_series(date_trunc('${trunc}', $1::date), $2::date, interval '${step}') AS g ORDER BY g`, from, to
  );
  const keys = spineRows.map((r) => r.bucket);
  const zeroMap = () => new Map(keys.map((k) => [k, 0]));
  const local = (col) => `to_char(date_trunc('${trunc}', (${col} AT TIME ZONE $3)), '${bucketLabel}')`;
  const inRange = (col) => `(${col} AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`;
  const args = [from, to, tz];

  // ── bookings ──
  const bookingRows = await prisma.$queryRawUnsafe(
    `SELECT ${local('b."createdAt"')} AS bucket, count(*)::int AS total,
            count(*) FILTER (WHERE b."status" = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE b."status" = 'CANCELLED')::int AS cancelled
     FROM "Booking" b WHERE ${inRange('b."createdAt"')} GROUP BY 1`, ...args);
  const bTotal = zeroMap(); const bDone = zeroMap(); const bCancel = zeroMap();
  for (const r of bookingRows) { bTotal.set(r.bucket, r.total); bDone.set(r.bucket, r.completed); bCancel.set(r.bucket, r.cancelled); }

  // ── money, on an event-date basis ──
  const gsvRows = await prisma.$queryRawUnsafe(
    `SELECT ${local('p."capturedAt"')} AS bucket, sum(p."serviceAmount")::float8 AS gsv, sum(p."totalAmount")::float8 AS payments
     FROM "Payment" p WHERE p."capturedAt" IS NOT NULL AND ${inRange('p."capturedAt"')} GROUP BY 1`, ...args);
  const commRows = await prisma.$queryRawUnsafe(
    `SELECT ${local('s."eligibleAt"')} AS bucket, sum(s."commission")::float8 AS commission
     FROM "WorkerSettlement" s WHERE s."status" IN ('ELIGIBLE','PAYOUT_PROCESSING','PAID','FAILED') AND s."eligibleAt" IS NOT NULL AND ${inRange('s."eligibleAt"')} GROUP BY 1`, ...args);
  const refundRows = await prisma.$queryRawUnsafe(
    `SELECT ${local('r."processedAt"')} AS bucket, sum(r."amount")::float8 AS refunds
     FROM "PaymentRefund" r WHERE r."status" = 'PROCESSED' AND r."kind" <> 'DUPLICATE_PAYMENT' AND r."processedAt" IS NOT NULL AND ${inRange('r."processedAt"')} GROUP BY 1`, ...args);
  const gsv = zeroMap(); const payments = zeroMap(); const comm = zeroMap(); const refunds = zeroMap();
  for (const r of gsvRows) { gsv.set(r.bucket, r.gsv); payments.set(r.bucket, r.payments); }
  for (const r of commRows) comm.set(r.bucket, r.commission);
  for (const r of refundRows) refunds.set(r.bucket, r.refunds);
  const money = (n) => Math.round(Number(n || 0) * 100) / 100;

  // ── growth ──
  const growthRows = await prisma.$queryRawUnsafe(
    `SELECT ${local('u."createdAt"')} AS bucket, u."role"::text AS role, count(*)::int AS n FROM "User" u
     WHERE u."role" IN ('CUSTOMER','WORKER') AND ${inRange('u."createdAt"')} GROUP BY 1, 2`, ...args);
  const newCust = zeroMap(); const newWork = zeroMap();
  for (const r of growthRows) (r.role === 'WORKER' ? newWork : newCust).set(r.bucket, r.n);
  const [before] = await prisma.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE u."role" = 'CUSTOMER')::int AS customers, count(*) FILTER (WHERE u."role" = 'WORKER')::int AS workers
     FROM "User" u WHERE (u."createdAt" AT TIME ZONE $1)::date < date_trunc('${trunc}', $2::date)::date`, tz, from);
  let cc = before.customers; let cw = before.workers;
  const customerGrowth = keys.map((k) => { cc += newCust.get(k); return { bucket: k, newCustomers: newCust.get(k), totalCustomers: cc }; });
  const workerGrowth = keys.map((k) => { cw += newWork.get(k); return { bucket: k, newWorkers: newWork.get(k), totalWorkers: cw }; });

  // ── popular categories (a booking's category: its service item, else its job post, else the worker's main category) ──
  const catRows = await prisma.$queryRawUnsafe(
    `SELECT c."id", c."name", count(b.*)::int AS bookings,
            count(*) FILTER (WHERE b."status" = 'COMPLETED')::int AS completed,
            coalesce(sum(b."agreedPrice") FILTER (WHERE b."status" = 'COMPLETED'), 0)::float8 AS "completedValue"
     FROM "Booking" b
     LEFT JOIN "ServiceItem" si ON si."id" = b."serviceItemId"
     LEFT JOIN "JobPost" jp ON jp."id" = b."jobPostId"
     LEFT JOIN "WorkerProfile" wp ON wp."userId" = b."workerId"
     JOIN "ServiceCategory" c ON c."id" = coalesce(si."categoryId", jp."categoryId", wp."primaryCategoryId")
     WHERE ${inRange('b."createdAt"')} GROUP BY c."id", c."name" ORDER BY bookings DESC, c."name" LIMIT 15`, ...args);

  // ── localities (the customer's service address: city + PIN code) ──
  const locRows = await prisma.$queryRawUnsafe(
    `SELECT a."city", a."postalCode", count(*)::int AS bookings,
            count(*) FILTER (WHERE b."status" = 'COMPLETED')::int AS completed,
            coalesce(sum(b."agreedPrice") FILTER (WHERE b."status" = 'COMPLETED'), 0)::float8 AS "completedValue"
     FROM "Booking" b JOIN "CustomerAddress" a ON a."id" = b."addressId"
     WHERE ${inRange('b."createdAt"')} GROUP BY a."city", a."postalCode" ORDER BY bookings DESC, a."city" LIMIT 10`, ...args);

  // ── rates (bookings created in the period, judged by what happened to them) ──
  const [rates] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE b."status" = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE b."status" = 'CANCELLED')::int AS cancelled,
            count(*) FILTER (WHERE b."status" = 'DISPUTED')::int AS disputed,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "BookingStatusHistory" h WHERE h."bookingId" = b."id" AND h."toStatus" = 'CONFIRMED'))::int AS accepted,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "BookingStatusHistory" h WHERE h."bookingId" = b."id" AND h."fromStatus" = 'REQUESTED' AND h."toStatus" = 'CANCELLED' AND h."changedById" = b."workerId"))::int AS declined
     FROM "Booking" b WHERE ${inRange('b."createdAt"')}`, ...args);

  return {
    range: { from, to, granularity: month ? 'month' : 'day', timezone: tz, buckets: keys.length },
    bookings: keys.map((k) => ({ bucket: k, total: bTotal.get(k), completed: bDone.get(k), cancelled: bCancel.get(k) })),
    revenue: {
      basis: 'By event date: service value of payments when captured, commission when the customer confirmed the job, refunds when processed.',
      series: keys.map((k) => ({ bucket: k, grossServiceValue: money(gsv.get(k)), customerPayments: money(payments.get(k)), commissionEarned: money(comm.get(k)), refunds: money(refunds.get(k)) }))
    },
    popularCategories: catRows.map((r) => ({ id: r.id, name: r.name, bookings: r.bookings, completed: r.completed, completedValue: money(r.completedValue) })),
    topLocalities: locRows.map((r) => ({ city: r.city, postalCode: r.postalCode, bookings: r.bookings, completed: r.completed, completedValue: money(r.completedValue) })),
    rates: {
      bookingsCreated: rates.total,
      acceptance: { rate: pct(rates.accepted, rates.accepted + rates.declined), accepted: rates.accepted, declined: rates.declined, note: 'Accepted ÷ (accepted + declined by the professional). Requests still waiting are not counted.' },
      cancellation: { rate: pct(rates.cancelled, rates.total), cancelled: rates.cancelled },
      completion: { rate: pct(rates.completed, rates.total), completed: rates.completed },
      disputed: rates.disputed
    },
    customerGrowth, workerGrowth
  };
};

module.exports = { report, pct };
