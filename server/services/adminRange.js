// Date-range filtering for admin reports. Dates are calendar days (YYYY-MM-DD) in the business time zone
// (BUSINESS_TIMEZONE, default Asia/Kolkata): `from` is the start of that day, `to` is the END of that day.
const timeZone = () => process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';
const MAX_DAYS = 800;

// Offset (ms) of `tz` from UTC at the given instant.
const offsetAt = (tz, ms) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
};

// UTC instant of local midnight at the start of `ymd` in tz.
const startOfDay = (ymd, tz = timeZone()) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - offsetAt(tz, guess);
  ms = guess - offsetAt(tz, ms);
  return new Date(ms);
};

const validYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const todayYmd = (tz = timeZone()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// → { from: Date|null, to: Date|null (exclusive upper bound), fromYmd, toYmd, days } or { error }.
// Both bounds are optional ("all time"). When both are given, from must not be after to.
const parseRange = (query = {}, { defaultDays = null } = {}) => {
  let { from, to } = query;
  from = from ? String(from) : ''; to = to ? String(to) : '';
  if (!from && !to && defaultDays) { to = todayYmd(); from = addDays(to, -(defaultDays - 1)); }
  if (from && !validYmd(from)) return { error: 'from must be a date in YYYY-MM-DD format.' };
  if (to && !validYmd(to)) return { error: 'to must be a date in YYYY-MM-DD format.' };
  if (from && to && from > to) return { error: 'from must not be after to.' };
  if (from && to) {
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (days > MAX_DAYS) return { error: `The date range may cover at most ${MAX_DAYS} days.` };
  }
  return {
    fromYmd: from || null, toYmd: to || null,
    from: from ? startOfDay(from) : null,
    to: to ? startOfDay(addDays(to, 1)) : null,
    days: from && to ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1 : null
  };
};

// Prisma where-fragment for a DateTime column.
const dateWhere = (range) => (range.from || range.to ? { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lt: range.to } : {}) } : undefined);

module.exports = { timeZone, parseRange, dateWhere, startOfDay, addDays, todayYmd, validYmd, MAX_DAYS };
