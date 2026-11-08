// Booking journey tracking.
//
// Rules this module enforces (all on the server; the browser is never trusted):
//  * Only the booking's customer and assigned worker can read tracking. Everyone else, including admins, is refused.
//  * A worker's position is shared with the customer ONLY while the journey is under way: status DISPATCHED and no
//    arrival confirmed. It stops (and the stored position is erased) on arrival, service start, completion,
//    cancellation or dispute.
//  * The position shared here is the booking-specific journey position. It is never taken from, and never written to,
//    the worker's marketplace availability location.
//  * Nothing is invented: no position -> none shown; no routing service -> no ETA (eta is always null).
//  * Freshness comes from the SERVER's receive time, never from the client's clock.
const prisma = require('../config/prisma');
const { activeTracking, getSocketServer, stopBookingTracking } = require('../trackingState');
const notifications = require('./notificationService');

const LIVE_MS = 45 * 1000;          // update newer than this: "live"
const STALE_MS = 3 * 60 * 1000;     // older than this: "stale" (last known position only)
const SWEEP_MS = 15 * 1000;
const MIN_INTERVAL_MS = 3 * 1000;   // updates faster than this are dropped (battery / server protection)
const PERSIST_EVERY_MS = 10 * 1000; // durable copy of the last position (survives a server restart)
const MAX_ACCURACY_M = 1000;        // worse than this is rejected: a marker 1 km off is misleading
const RELIABLE_ACCURACY_M = 200;    // distance is only shown for fixes at least this good
const MAX_FIX_AGE_MS = 2 * 60 * 1000;
const MAX_SPEED_KMH = 250;          // faster than this between two fixes is treated as a GPS glitch / spoof

class TrackError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
}

const roomFor = (bookingId) => `booking:${bookingId}`;

// ── pure helpers (unit tested) ───────────────────────────────────────────────

// Journey view of a booking. Derived from the existing status plus two timestamps; booking and payment states are untouched.
const journeyStatus = (b) => {
  switch (b.status) {
    case 'CONFIRMED': return 'BOOKING_ACCEPTED';
    case 'DISPATCHED': return b.arrivedAt ? 'WORKER_ARRIVED' : 'JOURNEY_STARTED';
    case 'IN_PROGRESS': return 'SERVICE_IN_PROGRESS';
    case 'AWAITING_CUSTOMER_CONFIRMATION': return 'COMPLETION_REQUESTED';
    case 'COMPLETED': return 'COMPLETED';
    default: return null; // REQUESTED, CANCELLED, DISPUTED have no journey
  }
};

const sharingActive = (b) => b.status === 'DISPATCHED' && !b.arrivedAt;

const freshness = (updatedAt, now = Date.now()) => {
  if (!updatedAt) return 'none';
  const age = now - new Date(updatedAt).getTime();
  if (age < 0 || age < LIVE_MS) return 'live';
  return age < STALE_MS ? 'delayed' : 'stale';
};

const haversineKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1); const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const roundDistance = (km) => (km < 10 ? Math.round(km * 10) / 10 : Math.round(km));

const validCoord = (v, min, max) => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

// Validates one incoming fix against the previous accepted one. Returns { ok, fix } or { ok:false, code, message }.
const validateFix = ({ latitude, longitude, accuracy, timestamp }, previous, now = Date.now()) => {
  if (!validCoord(latitude, -90, 90) || !validCoord(longitude, -180, 180)) return { ok: false, code: 'BAD_COORDS', message: 'A valid latitude and longitude are required.' };
  let acc = null;
  if (accuracy !== undefined && accuracy !== null && accuracy !== '') {
    acc = Number(accuracy);
    if (!Number.isFinite(acc) || acc < 0) return { ok: false, code: 'BAD_ACCURACY', message: 'Accuracy must be a non-negative number of meters.' };
    if (acc > MAX_ACCURACY_M) return { ok: false, code: 'INACCURATE', message: `GPS accuracy is too low (±${Math.round(acc)} m). Move to an open area or turn on high-accuracy location.` };
  }
  if (timestamp !== undefined && timestamp !== null && timestamp !== '') {
    const t = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    if (!Number.isFinite(t)) return { ok: false, code: 'BAD_TIMESTAMP', message: 'Invalid location timestamp.' };
    if (now - t > MAX_FIX_AGE_MS) return { ok: false, code: 'STALE_FIX', message: 'That GPS reading is too old. A fresh reading is needed.' };
  }
  const lat = Number(latitude); const lng = Number(longitude);
  if (previous && previous.at) {
    const hours = Math.max((now - previous.at) / 3600000, 1 / 3600);
    const kmh = haversineKm(previous.latitude, previous.longitude, lat, lng) / hours;
    if (hours < 1 && kmh > MAX_SPEED_KMH) return { ok: false, code: 'IMPLAUSIBLE_JUMP', message: 'That position change is not physically plausible, so it was ignored.' };
  }
  return { ok: true, fix: { latitude: lat, longitude: lng, accuracy: acc } };
};

// ── data access ──────────────────────────────────────────────────────────────

const BOOKING_SELECT = {
  id: true, status: true, customerId: true, workerId: true, scheduledAt: true, bookingNumber: true,
  journeyStartedAt: true, arrivedAt: true, trackLatitude: true, trackLongitude: true, trackAccuracy: true, trackUpdatedAt: true,
  address: { select: { latitude: true, longitude: true, street: true, city: true, postalCode: true } },
  customer: { select: { id: true, name: true } },
  worker: { select: { id: true, name: true, avatarUrl: true, workerProfile: { select: { primaryCategory: { select: { name: true } } } } } }
};

// Throws TrackError(400|404|403). Admins have no tracking access.
const loadForAccess = async (bookingId, userId) => {
  if (!bookingId || typeof bookingId !== 'string') throw new TrackError(400, 'A booking is required.', 'BAD_REQUEST');
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: BOOKING_SELECT });
  if (!booking) throw new TrackError(404, 'Booking not found.', 'NOT_FOUND');
  const uid = String(userId);
  const role = booking.customerId === uid ? 'Customer' : booking.workerId === uid ? 'Worker' : null;
  if (!role) throw new TrackError(403, 'You are not part of this booking, so you cannot access its tracking.', 'FORBIDDEN');
  return { booking, role };
};

const lastKnown = (booking) => (booking.trackLatitude != null && booking.trackLongitude != null && booking.trackUpdatedAt
  ? { latitude: booking.trackLatitude, longitude: booking.trackLongitude, accuracy: booking.trackAccuracy, timestamp: booking.trackUpdatedAt.toISOString() }
  : null);

// What a participant is allowed to see. The ONLY place coordinates leave the server for a booking.
const viewFor = ({ booking, role, now = Date.now() }) => {
  const sharing = sharingActive(booking);
  const mem = activeTracking.get(booking.id);
  const loc = sharing ? ((mem && mem.lastLocation) || lastKnown(booking)) : null;
  const updatedAt = loc ? (mem && mem.lastUpdated) || loc.timestamp : null;
  const fresh = loc ? freshness(updatedAt, now) : 'none';
  const ageMs = updatedAt ? now - new Date(updatedAt).getTime() : null;
  const reliable = Boolean(loc && loc.accuracy != null && loc.accuracy <= RELIABLE_ACCURACY_M && ageMs !== null && ageMs < 2 * 60 * 1000);
  const dest = booking.address && booking.address.latitude != null && booking.address.longitude != null ? { latitude: Number(booking.address.latitude), longitude: Number(booking.address.longitude) } : null;
  let distanceKm = null;
  if (reliable && dest) distanceKm = roundDistance(haversineKm(loc.latitude, loc.longitude, dest.latitude, dest.longitude));
  const view = {
    bookingId: booking.id, bookingNumber: booking.bookingNumber, status: booking.status, journeyStatus: journeyStatus(booking),
    journeyStartedAt: booking.journeyStartedAt || null, arrivedAt: booking.arrivedAt || null,
    sharing, // true only while the worker is on the road to this customer
    paused: Boolean(sharing && mem && (mem.status === 'STALE' || mem.workerConnected === false)), // worker's page closed / connection lost / paused
    location: loc, lastUpdated: updatedAt, freshness: fresh,
    distanceKm, distanceNote: distanceKm !== null ? 'Straight-line distance, not driving distance.' : null,
    eta: null, etaNote: 'Arrival time estimates are not available: LocalHire has no routing service configured.',
    worker: { id: booking.worker.id, name: booking.worker.name, avatarUrl: booking.worker.avatarUrl || null, profession: (booking.worker.workerProfile && booking.worker.workerProfile.primaryCategory && booking.worker.workerProfile.primaryCategory.name) || 'Service professional' }
  };
  if (role === 'Customer') view.destination = dest; // the customer's own address, to show their pin
  if (role === 'Worker' && ['CONFIRMED', 'DISPATCHED', 'IN_PROGRESS'].includes(booking.status)) {
    view.destination = dest;
    view.address = booking.address ? [booking.address.street, booking.address.city, booking.address.postalCode].filter(Boolean).join(', ') : null;
    view.customerName = booking.customer && booking.customer.name;
  }
  return view;
};

const getTracking = async ({ bookingId, userId }) => {
  const { booking, role } = await loadForAccess(bookingId, userId);
  return { role, tracking: viewFor({ booking, role }) };
};

// ── live updates ─────────────────────────────────────────────────────────────

const emitRoom = (bookingId, event, payload) => { const io = getSocketServer(); if (io) io.to(roomFor(bookingId)).emit(event, payload); };

// The worker's own client sends fixes here (socket or REST). Returns { accepted, throttled?, payload }.
const recordLocation = async ({ bookingId, workerId, latitude, longitude, accuracy, timestamp, now = Date.now() }) => {
  const { booking, role } = await loadForAccess(bookingId, workerId);
  if (role !== 'Worker') throw new TrackError(403, 'Only the assigned professional can send location updates.', 'FORBIDDEN');
  if (!sharingActive(booking)) throw new TrackError(409, booking.arrivedAt ? 'You have already marked yourself as arrived, so location sharing has ended.' : 'Location is shared only while the journey is under way. Start the journey first.', 'NOT_TRACKING');

  let state = activeTracking.get(bookingId);
  if (!state) {
    state = { bookingId, workerId: booking.workerId, customerId: booking.customerId, startedAt: new Date(now).toISOString(), lastLocation: lastKnown(booking), lastUpdated: booking.trackUpdatedAt ? booking.trackUpdatedAt.toISOString() : null, lastAcceptedAt: 0, lastPersistAt: 0, status: 'ACTIVE', staleNotified: false, workerConnected: true };
    activeTracking.set(bookingId, state);
  }
  if (now - state.lastAcceptedAt < MIN_INTERVAL_MS) return { accepted: false, throttled: true };

  const previous = state.lastLocation && state.lastAcceptedAt ? { latitude: state.lastLocation.latitude, longitude: state.lastLocation.longitude, at: state.lastAcceptedAt } : null;
  const v = validateFix({ latitude, longitude, accuracy, timestamp }, previous, now);
  if (!v.ok) throw new TrackError(422, v.message, v.code);

  const received = new Date(now).toISOString();
  const wasStale = state.status === 'STALE' || state.workerConnected === false;
  state.lastLocation = { latitude: v.fix.latitude, longitude: v.fix.longitude, accuracy: v.fix.accuracy, timestamp: received };
  state.lastUpdated = received; state.lastAcceptedAt = now; state.status = 'ACTIVE'; state.staleNotified = false;
  state.workerConnected = true;

  const persistData = { trackLatitude: v.fix.latitude, trackLongitude: v.fix.longitude, trackAccuracy: v.fix.accuracy, trackUpdatedAt: new Date(now) };
  if (now - state.lastPersistAt >= PERSIST_EVERY_MS) {
    state.lastPersistAt = now; state.pendingPersist = null;
    await prisma.booking.updateMany({ where: { id: bookingId, status: 'DISPATCHED', arrivedAt: null }, data: persistData });
  } else {
    state.pendingPersist = persistData; // written by flushPending() so the stored copy never lags behind for long
  }

  const view = viewFor({ booking: { ...booking, trackLatitude: v.fix.latitude, trackLongitude: v.fix.longitude, trackAccuracy: v.fix.accuracy, trackUpdatedAt: new Date(now) }, role: 'Customer', now });
  const payload = {
    bookingId, workerId: booking.workerId, customerId: booking.customerId, location: state.lastLocation, lastUpdated: received, status: state.status,
    freshness: 'live', distanceKm: view.distanceKm, distanceNote: view.distanceNote, journeyStatus: journeyStatus(booking), eta: null, persistedToDb: true
  };
  emitRoom(bookingId, 'worker:location:changed', payload);
  emitRoom(bookingId, 'tracking:location', payload);
  if (wasStale) emitRoom(bookingId, 'tracking:resumed', { bookingId, lastUpdated: received });
  return { accepted: true, payload };
};

// Worker confirms they have arrived. Ends live sharing and erases the stored position.
const markArrived = async ({ bookingId, workerId }) => {
  const { booking, role } = await loadForAccess(bookingId, workerId);
  if (role !== 'Worker') throw new TrackError(403, 'Only the assigned professional can confirm arrival.', 'FORBIDDEN');
  if (booking.status !== 'DISPATCHED') throw new TrackError(409, 'You can confirm arrival only after you have started the journey.', 'NOT_ON_JOURNEY');
  if (booking.arrivedAt) throw new TrackError(409, 'Arrival was already confirmed.', 'ALREADY_ARRIVED');
  const r = await prisma.booking.updateMany({
    where: { id: bookingId, status: 'DISPATCHED', arrivedAt: null },
    data: { arrivedAt: new Date(), trackLatitude: null, trackLongitude: null, trackAccuracy: null, trackUpdatedAt: null }
  });
  if (r.count !== 1) throw new TrackError(409, 'Arrival was already confirmed.', 'ALREADY_ARRIVED');
  stopBookingTracking(bookingId, 'The professional has arrived. Live location sharing has ended.');
  emitRoom(bookingId, 'booking:status:changed', { bookingId, status: 'DISPATCHED', journeyStatus: 'WORKER_ARRIVED', changedById: workerId });
  notifications.notify({ userId: booking.customerId, type: 'WORKER_ARRIVED', bookingId, title: 'Your professional has arrived', message: `${booking.worker.name || 'The professional'} has arrived at your location.` });
  return { arrivedAt: new Date() };
};

// Erase the stored position and stop live sharing (used whenever the journey no longer needs it).
const endTracking = async (bookingId, message) => {
  await prisma.booking.updateMany({ where: { id: bookingId }, data: { trackLatitude: null, trackLongitude: null, trackAccuracy: null, trackUpdatedAt: null } });
  stopBookingTracking(bookingId, message || 'Location sharing ended.');
};

// Fields to set on a booking when its status leaves the journey phase.
const CLEAR_TRACK = { trackLatitude: null, trackLongitude: null, trackAccuracy: null, trackUpdatedAt: null };

// The worker's connection or page went away: keep the last position but say it is no longer live.
const markWorkerGone = (bookingId, reason) => {
  const state = activeTracking.get(bookingId);
  if (!state) return false;
  state.workerConnected = false; state.status = 'STALE';
  if (!state.staleNotified) {
    state.staleNotified = true;
    emitRoom(bookingId, 'tracking:stale', { bookingId, reason, lastUpdated: state.lastUpdated, message: reason === 'worker_disconnected' ? 'The professional\'s connection was lost. Showing the last known position.' : reason === 'worker_paused' ? 'The professional paused live location sharing. Showing the last known position.' : 'Location updates have stopped. Showing the last known position.' });
  }
  return true;
};

// No fix for a while (browser closed, phone locked, OS suspended the page): stop showing a false "live" status.
const sweepStale = (now = Date.now()) => {
  let marked = 0;
  for (const [bookingId, state] of activeTracking) {
    if (state.staleNotified || !state.lastAcceptedAt) continue;
    if (now - state.lastAcceptedAt > 90 * 1000) { state.status = 'STALE'; state.staleNotified = true; marked += 1; emitRoom(bookingId, 'tracking:stale', { bookingId, reason: 'no_updates', lastUpdated: state.lastUpdated, message: 'Location updates have stopped. Showing the last known position.' }); }
  }
  return marked;
};
// The durable copy is written at most every PERSIST_EVERY_MS; a newer position that arrived in between is written here.
const flushPending = async (now = Date.now()) => {
  let flushed = 0;
  for (const [bookingId, state] of activeTracking) {
    if (!state.pendingPersist || now - state.lastPersistAt < PERSIST_EVERY_MS) continue;
    const data = state.pendingPersist; state.pendingPersist = null; state.lastPersistAt = now;
    try { await prisma.booking.updateMany({ where: { id: bookingId, status: 'DISPATCHED', arrivedAt: null }, data }); flushed += 1; } catch (e) { console.warn('[Tracking] could not persist last position:', e.message); }
  }
  return flushed;
};
let sweeper = null;
const startSweeper = () => { if (!sweeper) { sweeper = setInterval(() => { sweepStale(); flushPending(); }, SWEEP_MS); if (sweeper.unref) sweeper.unref(); } };
const stopSweeper = () => { if (sweeper) { clearInterval(sweeper); sweeper = null; } };

// Booking payloads never carry journey coordinates. Adds the derived journeyStatus instead.
const sanitizeBooking = (b) => {
  if (!b || typeof b !== 'object') return b;
  const { trackLatitude, trackLongitude, trackAccuracy, trackUpdatedAt, ...rest } = b;
  return { ...rest, journeyStatus: journeyStatus(rest) };
};

module.exports = {
  TrackError, LIVE_MS, STALE_MS, MIN_INTERVAL_MS, MAX_ACCURACY_M, RELIABLE_ACCURACY_M, CLEAR_TRACK, roomFor,
  journeyStatus, sharingActive, freshness, haversineKm, validateFix, loadForAccess, viewFor, getTracking, recordLocation, markArrived,
  endTracking, markWorkerGone, sweepStale, flushPending, startSweeper, stopSweeper, sanitizeBooking
};
