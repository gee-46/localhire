// Server-side check that a booking starts inside the worker's published working hours.
//
// Working hours are wall-clock times ("09:00"-"18:00") on a weekday, so they must be interpreted in a time zone.
// BUSINESS_TIMEZONE (IANA name, default Asia/Kolkata) is the zone the platform operates in; the booking's UTC
// instant is converted to that zone before comparing. A worker who has published NO hours is not restricted.
const prisma = require('../config/prisma');

const timeZone = () => process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata';

// -> { dayOfWeek: 0-6, minutes: minutes since local midnight }
const localParts = (date, tz = timeZone()) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dayOfWeek, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
};

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Pure: availability = [{dayOfWeek, startTime, endTime}], blocked = [{startDateTime, endDateTime}]
const checkBookingTime = ({ availability, blocked = [], scheduledAt, tz }) => {
  if (!availability.length) return { ok: true, restricted: false };
  const { dayOfWeek, minutes } = localParts(scheduledAt, tz);
  const row = availability.find((a) => a.dayOfWeek === dayOfWeek);
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (!row) return { ok: false, restricted: true, reason: `This professional does not work on ${names[dayOfWeek]}s. Please choose another day.` };
  if (minutes < toMinutes(row.startTime) || minutes >= toMinutes(row.endTime)) {
    return { ok: false, restricted: true, reason: `This professional works ${row.startTime}-${row.endTime} on ${names[dayOfWeek]}s. Please choose a time within those hours.` };
  }
  const clash = blocked.find((b) => scheduledAt >= new Date(b.startDateTime) && scheduledAt < new Date(b.endDateTime));
  if (clash) return { ok: false, restricted: true, reason: 'This professional is unavailable at that time. Please choose another time.' };
  return { ok: true, restricted: true };
};

const validateForWorker = async (workerUserId, scheduledAt) => {
  const [availability, blocked] = await Promise.all([
    prisma.professionalAvailability.findMany({ where: { isActive: true, workerProfile: { userId: workerUserId } }, select: { dayOfWeek: true, startTime: true, endTime: true } }),
    prisma.professionalBlockedPeriod.findMany({ where: { workerProfile: { userId: workerUserId }, endDateTime: { gt: scheduledAt }, startDateTime: { lte: scheduledAt } }, select: { startDateTime: true, endDateTime: true } })
  ]);
  return checkBookingTime({ availability, blocked, scheduledAt });
};

module.exports = { timeZone, localParts, checkBookingTime, validateForWorker };
