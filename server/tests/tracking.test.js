// Worker availability + booking journey tracking: real Express, real PostgreSQL/PostGIS, real Socket.IO.
// No GPS hardware is involved (tests send coordinates like a browser would); nothing here claims anything about
// real devices. Location values asserted below are the ones the tests themselves sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.TRACKING_RATE_LIMIT_MAX = '100000';

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { activeTracking } = require('../trackingState');
const tracking = require('../services/trackingService');
const { server } = require('../server');

const tag = `trk${Date.now()}`;
const created = [];
const sockets = [];
let base; let plumber; let seq = 0;

async function api(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}
async function makeUser(label, role) {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210' } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}
async function makeWorker(label) {
  const w = await makeUser(label, 'WORKER');
  const profile = await prisma.workerProfile.create({ data: { userId: w.user.id, primaryCategoryId: plumber.id, verificationStatus: 'VERIFIED', hourlyRate: 300, bio: 'Plumber' } });
  return { ...w, profile };
}
// customer's address is the destination (Belagavi); the worker starts ~3 km away
const DEST = { latitude: 15.8497, longitude: 74.4977 };
const NEAR = { latitude: 15.8767, longitude: 74.4977 }; // 3.0 km north
async function makeBooking(c, w, status = 'CONFIRMED', extra = {}) {
  const address = await prisma.customerAddress.create({ data: { customerId: c.user.id, street: '12 Test Street', city: 'Belagavi', postalCode: '590001', latitude: DEST.latitude, longitude: DEST.longitude } });
  return prisma.booking.create({ data: { bookingNumber: `BK-${tag}-${++seq}`, customerId: c.user.id, workerId: w.user.id, addressId: address.id, status, agreedPrice: 500, scheduledAt: new Date(Date.now() + 3600000), ...extra } });
}
const setStatus = (token, id, status) => api('PUT', `/api/bookings/${id}/status`, { token, json: { status } });
const bump = (id) => { const st = activeTracking.get(id); if (st) st.lastAcceptedAt = Date.now() - 3500; }; // lets a test send successive fixes without waiting out the 3 s throttle (the previous fix is treated as 3.5 s old)
const sendFix = (token, id, fix) => { bump(id); return api('POST', `/api/bookings/${id}/location`, { token, json: fix }); };
const booking = (id) => prisma.booking.findUnique({ where: { id } });

function connect(token, opts = {}) {
  const socket = ioClient(base, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: opts.reconnection !== false, reconnectionDelay: 50, reconnectionDelayMax: 200, forceNew: true });
  const received = [];
  socket.onAny((event, ...args) => received.push({ event, args }));
  const c = {
    socket, received,
    ready: () => new Promise((resolve, reject) => { if (socket.connected) return resolve(); socket.once('connect', resolve); socket.once('connect_error', reject); }),
    when: (event, match, ms = 4000) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => { const hit = received.find((r) => r.event === event && (!match || match(...r.args))); if (hit) return resolve(hit.args[0]); if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${event}`)); setTimeout(tick, 20); };
      tick();
    }),
    count: (event) => received.filter((r) => r.event === event).length,
    emit: (event, data) => new Promise((resolve) => socket.timeout(4000).emit(event, data, (err, res) => resolve(err ? { ok: false, error: 'timeout' } : res))),
    close: () => socket.close()
  };
  sockets.push(c);
  return c;
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  sockets.forEach((c) => c.close());
  const bookings = (await prisma.booking.findMany({ where: { OR: [{ customerId: { in: created } }, { workerId: { in: created } }] }, select: { id: true } })).map((b) => b.id);
  await prisma.notification.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookings } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { id: { in: bookings } } }).catch(() => {});
  await prisma.customerAddress.deleteMany({ where: { customerId: { in: created } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  tracking.stopSweeper();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ─── Pure rules ─────────────────────────────────────────────────────────────

test('journey status is derived from the existing booking status without changing it', () => {
  const j = (status, arrivedAt = null) => tracking.journeyStatus({ status, arrivedAt });
  assert.equal(j('REQUESTED'), null);
  assert.equal(j('CONFIRMED'), 'BOOKING_ACCEPTED');
  assert.equal(j('DISPATCHED'), 'JOURNEY_STARTED');
  assert.equal(j('DISPATCHED', new Date()), 'WORKER_ARRIVED');
  assert.equal(j('IN_PROGRESS'), 'SERVICE_IN_PROGRESS');
  assert.equal(j('AWAITING_CUSTOMER_CONFIRMATION'), 'COMPLETION_REQUESTED');
  assert.equal(j('COMPLETED'), 'COMPLETED');
  assert.equal(j('CANCELLED'), null);
  assert.equal(j('DISPUTED'), null);
  assert.equal(tracking.sharingActive({ status: 'DISPATCHED', arrivedAt: null }), true);
  assert.equal(tracking.sharingActive({ status: 'DISPATCHED', arrivedAt: new Date() }), false);
  assert.equal(tracking.sharingActive({ status: 'CONFIRMED', arrivedAt: null }), false);
  assert.equal(tracking.sharingActive({ status: 'IN_PROGRESS', arrivedAt: null }), false);
});

test('freshness is judged from the server receive time: live, delayed, stale, none', () => {
  const now = Date.now();
  assert.equal(tracking.freshness(null, now), 'none');
  assert.equal(tracking.freshness(new Date(now - 10000), now), 'live');
  assert.equal(tracking.freshness(new Date(now - 2 * 60 * 1000), now), 'delayed');
  assert.equal(tracking.freshness(new Date(now - 10 * 60 * 1000), now), 'stale');
  assert.ok(Math.abs(tracking.haversineKm(15.8497, 74.4977, 15.8767, 74.4977) - 3.0) < 0.05);
});

test('GPS fixes are validated: coordinates, accuracy, age, impossible jumps', () => {
  const now = Date.now();
  const ok = tracking.validateFix({ latitude: 15.85, longitude: 74.5, accuracy: 20, timestamp: now - 5000 }, null, now);
  assert.equal(ok.ok, true);
  const bad = (fix, prev) => tracking.validateFix(fix, prev || null, now);
  assert.equal(bad({ latitude: 91, longitude: 0 }).code, 'BAD_COORDS');
  assert.equal(bad({ latitude: 'abc', longitude: 0 }).code, 'BAD_COORDS');
  assert.equal(bad({ latitude: null, longitude: 0 }).code, 'BAD_COORDS');
  assert.equal(bad({ latitude: 15, longitude: 181 }).code, 'BAD_COORDS');
  assert.equal(bad({ latitude: 15, longitude: 74, accuracy: -3 }).code, 'BAD_ACCURACY');
  assert.equal(bad({ latitude: 15, longitude: 74, accuracy: tracking.MAX_ACCURACY_M + 1 }).code, 'INACCURATE');
  assert.equal(bad({ latitude: 15, longitude: 74, accuracy: tracking.MAX_ACCURACY_M }).ok, true);
  assert.equal(bad({ latitude: 15, longitude: 74, timestamp: now - 5 * 60 * 1000 }).code, 'STALE_FIX');
  assert.equal(bad({ latitude: 15, longitude: 74, timestamp: 'garbage' }).code, 'BAD_TIMESTAMP');
  // 100 km in 10 seconds is a glitch or a spoof
  const prev = { latitude: 15, longitude: 74, at: now - 10000 };
  assert.equal(bad({ latitude: 15.9, longitude: 74 }, prev).code, 'IMPLAUSIBLE_JUMP');
  assert.equal(bad({ latitude: 15.0005, longitude: 74 }, prev).ok, true, '50 m in 10 s is walking pace');
});

// ─── Worker online / offline ────────────────────────────────────────────────

test('worker online/offline: fix is stored with accuracy and PostGIS point; offline erases it; coarse public pin only', async () => {
  const w = await makeWorker('on-w');
  const patch = (json) => api('PATCH', '/api/users/location', { token: w.token, json });

  assert.equal((await patch({ sharingEnabled: true, isAvailable: true })).status, 400, 'no coordinates');
  assert.equal((await patch({ sharingEnabled: true, isAvailable: true, latitude: 95, longitude: 74 })).status, 400);
  let r = await patch({ sharingEnabled: true, isAvailable: true, latitude: 15.85, longitude: 74.5, accuracy: 3500 });
  assert.equal(r.status, 422); assert.equal(r.data.code, 'LOW_ACCURACY');
  r = await patch({ sharingEnabled: true, isAvailable: true, latitude: 15.85, longitude: 74.5, accuracy: 30, timestamp: Date.now() - 10 * 60 * 1000 });
  assert.equal(r.status, 422); assert.equal(r.data.code, 'STALE_FIX');
  assert.equal((await api('GET', '/api/users/location', { token: w.token })).data.location.isAvailable, false, 'refused updates changed nothing');

  const PRECISE = { latitude: 15.851234, longitude: 74.512345 };
  r = await patch({ sharingEnabled: true, isAvailable: true, ...PRECISE, accuracy: 18.5, timestamp: Date.now() - 2000 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.location.accuracyMeters, 18.5);
  const [pt] = await prisma.$queryRaw`SELECT ST_Y("location"::geometry) AS lat, ST_X("location"::geometry) AS lng FROM "WorkerLocation" WHERE "workerProfileId" = ${w.profile.id}`;
  assert.ok(Math.abs(pt.lat - PRECISE.latitude) < 1e-6 && Math.abs(pt.lng - PRECISE.longitude) < 1e-6, 'PostGIS point follows the stored fix');
  const mine = await api('GET', '/api/users/location', { token: w.token });
  assert.equal(mine.data.isFresh, true); assert.equal(mine.data.location.accuracyMeters, 18.5); assert.equal(mine.data.maxAccuracyMeters, 2000);

  // public discovery: found, but with a coarse pin that is not the worker's position
  const pub = await api('GET', `/api/users/workers?lat=15.85&lng=74.5&radiusKm=20&limit=50`);
  const found = pub.data.workers.find((x) => x.id === w.user.id || x._id === w.user.id);
  assert.ok(found, 'online worker is discoverable');
  assert.equal('mapLocation' in found, false, 'no public map pin, not even a coarse one');
  assert.equal(Object.keys(found).some((k) => /^(lat|lng|latitude|longitude|location|coordinates)$/i.test(k) && typeof found[k] === 'number'), false);
  const text = JSON.stringify(pub.data);
  assert.equal(text.includes('15.851234') || text.includes('74.512345'), false, 'the exact coordinates never appear in a public response');
  assert.equal(found.distanceKm % 0.5, 0, 'distance is rounded to 0.5 km');
  const profile = await api('GET', `/api/users/workers/${w.user.id}`);
  assert.equal(JSON.stringify(profile.data).includes('15.8512'), false);

  // going offline stops availability tracking and erases the position
  r = await patch({ sharingEnabled: false, isAvailable: false });
  assert.equal(r.status, 200);
  const row = await prisma.workerLocation.findUnique({ where: { workerProfileId: w.profile.id } });
  assert.deepEqual([row.latitude, row.longitude, row.lastLocationUpdate, row.accuracyMeters], [null, null, null, null]);
  const after = await api('GET', `/api/users/workers?lat=15.85&lng=74.5&radiusKm=20&limit=50`);
  assert.equal(after.data.workers.some((x) => x.id === w.user.id), false, 'offline workers are not listed');
  // only workers can use it
  const c = await makeUser('on-c', 'CUSTOMER');
  assert.equal((await api('PATCH', '/api/users/location', { token: c.token, json: { sharingEnabled: true, isAvailable: true, latitude: 15, longitude: 74 } })).status, 403);
  assert.equal((await api('PATCH', '/api/users/location', { json: {} })).status, 401);
});

test('an online worker whose app stopped updating drops out of search once the position is stale', async () => {
  const w = await makeWorker('stale-w');
  await api('PATCH', '/api/users/location', { token: w.token, json: { sharingEnabled: true, isAvailable: true, latitude: 15.85, longitude: 74.5, accuracy: 25 } });
  const search = async () => (await api('GET', '/api/users/workers?lat=15.85&lng=74.5&radiusKm=20&limit=50')).data.workers.some((x) => x.id === w.user.id);
  assert.equal(await search(), true);
  await prisma.workerLocation.update({ where: { workerProfileId: w.profile.id }, data: { lastLocationUpdate: new Date(Date.now() - 20 * 60 * 1000) } });
  assert.equal(await search(), false, 'a 20-minute-old position is not treated as online');
  const mine = await api('GET', '/api/users/location', { token: w.token });
  assert.equal(mine.data.isFresh, false);
  assert.equal(mine.data.location.sharingEnabled, true, 'the worker is told their position is stale, not silently switched off');
});

// ─── Journey over the REST API ──────────────────────────────────────────────

test('journey: start (explicit), live fixes, arrival ends sharing and erases the position; booking and payment states untouched', async () => {
  const c = await makeUser('j-c', 'CUSTOMER'); const w = await makeWorker('j-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  const track = (who) => api('GET', `/api/bookings/${b.id}/tracking`, { token: who.token });

  let t = await track(c);
  assert.equal(t.data.tracking.journeyStatus, 'BOOKING_ACCEPTED');
  assert.equal(t.data.tracking.sharing, false);
  assert.equal(t.data.tracking.location, null, 'no journey, no position');
  assert.equal(t.data.tracking.eta, null);
  assert.match(t.data.tracking.etaNote, /no routing service/i);
  // the worker cannot send a position before starting the journey
  let r = await sendFix(w.token, b.id, { ...NEAR, accuracy: 15 });
  assert.equal(r.status, 409); assert.equal(r.data.code, 'NOT_TRACKING');

  // explicit start
  assert.equal((await setStatus(w.token, b.id, 'DISPATCHED')).status, 200);
  let row = await booking(b.id);
  assert.ok(row.journeyStartedAt); assert.equal(row.arrivedAt, null); assert.equal(row.status, 'DISPATCHED');
  t = await track(c);
  assert.equal(t.data.tracking.journeyStatus, 'JOURNEY_STARTED'); assert.equal(t.data.tracking.sharing, true); assert.equal(t.data.tracking.location, null, 'sharing has begun but no fix yet: nothing is invented');
  assert.equal(t.data.tracking.freshness, 'none');

  // a good fix
  r = await sendFix(w.token, b.id, { ...NEAR, accuracy: 12, timestamp: Date.now() });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.accepted, true);
  t = await track(c);
  const tr = t.data.tracking;
  assert.equal(tr.freshness, 'live');
  assert.deepEqual([tr.location.latitude, tr.location.longitude, tr.location.accuracy], [NEAR.latitude, NEAR.longitude, 12]);
  assert.ok(Math.abs(tr.distanceKm - 3.0) < 0.1, `distance ${tr.distanceKm}`);
  assert.match(tr.distanceNote, /straight-line/i);
  assert.equal(tr.eta, null);
  assert.equal(tr.worker.name, w.user.name); assert.equal(tr.worker.profession, 'Plumber');
  assert.ok(tr.lastUpdated);
  assert.equal(tr.destination.latitude, DEST.latitude, 'customers get their own destination for the map');
  assert.equal(t.data.tracking.address, undefined, 'customers do not get the worker-side navigation block');

  // the worker's view includes navigation info
  const wt = await track(w);
  assert.equal(wt.data.role, 'Worker'); assert.equal(wt.data.tracking.destination.longitude, DEST.longitude); assert.match(wt.data.tracking.address, /12 Test Street/);

  // a fix worse than 1 km is rejected; a fair one is shown but no distance is claimed from it
  r = await sendFix(w.token, b.id, { ...NEAR, accuracy: 1500 });
  assert.equal(r.status, 422); assert.equal(r.data.code, 'INACCURATE');
  r = await sendFix(w.token, b.id, { ...NEAR, accuracy: 350 });
  assert.equal(r.status, 200);
  assert.equal((await track(c)).data.tracking.distanceKm, null, 'accuracy worse than 200 m: distance is not reliable, so it is not shown');

  // arrival
  assert.equal((await api('POST', `/api/bookings/${b.id}/arrive`, { token: c.token })).status, 403, 'customers cannot confirm arrival');
  const outsider = await makeWorker('j-w2');
  assert.equal((await api('POST', `/api/bookings/${b.id}/arrive`, { token: outsider.token })).status, 403, 'an unassigned worker cannot');
  r = await api('POST', `/api/bookings/${b.id}/arrive`, { token: w.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  row = await booking(b.id);
  assert.ok(row.arrivedAt);
  assert.deepEqual([row.trackLatitude, row.trackLongitude, row.trackAccuracy, row.trackUpdatedAt], [null, null, null, null], 'the stored position is erased');
  assert.equal(row.status, 'DISPATCHED', 'booking status is unchanged by arrival');
  t = await track(c);
  assert.equal(t.data.tracking.journeyStatus, 'WORKER_ARRIVED'); assert.equal(t.data.tracking.sharing, false); assert.equal(t.data.tracking.location, null);
  assert.equal((await api('POST', `/api/bookings/${b.id}/arrive`, { token: w.token })).status, 409);
  r = await sendFix(w.token, b.id, { ...NEAR, accuracy: 10 });
  assert.equal(r.status, 409, 'no more sharing after arrival');
  const n = await prisma.notification.findFirst({ where: { userId: c.user.id, type: 'WORKER_ARRIVED', bookingId: b.id } });
  assert.ok(n);

  // service, completion request
  assert.equal((await setStatus(w.token, b.id, 'IN_PROGRESS')).status, 200);
  assert.equal((await track(c)).data.tracking.journeyStatus, 'SERVICE_IN_PROGRESS');
  assert.equal((await prisma.notification.count({ where: { userId: c.user.id, bookingId: b.id, type: 'WORKER_ARRIVED' } })), 2, 'arrival and service start are separate notifications');
  assert.equal((await setStatus(w.token, b.id, 'AWAITING_CUSTOMER_CONFIRMATION')).status, 200);
  assert.equal((await track(c)).data.tracking.journeyStatus, 'COMPLETION_REQUESTED');
  await prisma.booking.update({ where: { id: b.id }, data: { status: 'COMPLETED' } });
  t = await track(c);
  assert.equal(t.data.tracking.journeyStatus, 'COMPLETED'); assert.equal(t.data.tracking.location, null);
  assert.equal((await prisma.payment.count({ where: { bookingId: b.id } })), 0, 'tracking never touches payments');
});

test('arrival is only possible after the journey started; starting the service also ends sharing', async () => {
  const c = await makeUser('ar-c', 'CUSTOMER'); const w = await makeWorker('ar-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  assert.equal((await api('POST', `/api/bookings/${b.id}/arrive`, { token: w.token })).status, 409, 'cannot arrive without starting the journey');
  await setStatus(w.token, b.id, 'DISPATCHED');
  await sendFix(w.token, b.id, { ...NEAR, accuracy: 20 });
  assert.ok((await booking(b.id)).trackLatitude != null);
  // the worker goes straight to "start service" without pressing arrive: they are evidently there
  await setStatus(w.token, b.id, 'IN_PROGRESS');
  const row = await booking(b.id);
  assert.ok(row.arrivedAt); assert.equal(row.trackLatitude, null);
  assert.equal((await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token })).data.tracking.location, null);
});

test('location updates are validated, throttled and restricted to the assigned worker', async () => {
  const c = await makeUser('v-c', 'CUSTOMER'); const w = await makeWorker('v-w'); const w2 = await makeWorker('v-w2');
  const b = await makeBooking(c, w, 'DISPATCHED', { journeyStartedAt: new Date() });
  const post = (token, json) => api('POST', `/api/bookings/${b.id}/location`, { token, json });
  assert.equal((await post(c.token, { ...NEAR })).status, 403, 'customers cannot post positions');
  assert.equal((await post(w2.token, { ...NEAR })).status, 403, 'neither can another worker');
  assert.equal((await api('POST', `/api/bookings/${b.id}/location`, { json: NEAR })).status, 401);
  assert.equal((await post(w.token, { latitude: 'north', longitude: 74 })).data.code, 'BAD_COORDS');
  assert.equal((await post(w.token, { latitude: 15.85, longitude: 74.5, timestamp: Date.now() - 10 * 60 * 1000 })).data.code, 'STALE_FIX');
  assert.equal((await booking(b.id)).trackLatitude, null, 'rejected fixes store nothing');

  assert.equal((await post(w.token, { ...NEAR, accuracy: 10 })).data.accepted, true);
  const quick = await post(w.token, { ...NEAR, accuracy: 10 }); // within 3 s: dropped, not an error
  assert.equal(quick.status, 200); assert.equal(quick.data.throttled, true); assert.equal(quick.data.accepted, false);
  bump(b.id);
  const jump = await post(w.token, { latitude: 16.9, longitude: 74.5, accuracy: 10 }); // ~115 km away a moment later
  assert.equal(jump.status, 422); assert.equal(jump.data.code, 'IMPLAUSIBLE_JUMP');
  bump(b.id);
  assert.equal((await post(w.token, { latitude: NEAR.latitude + 0.0002, longitude: NEAR.longitude, accuracy: 10 })).data.accepted, true, 'a believable move is accepted');
});

// ─── Privacy ────────────────────────────────────────────────────────────────

test('only the customer and assigned worker can read tracking; booking payloads never carry coordinates', async () => {
  const c = await makeUser('p-c', 'CUSTOMER'); const other = await makeUser('p-o', 'CUSTOMER');
  const w = await makeWorker('p-w'); const w2 = await makeWorker('p-w2'); const admin = await makeUser('p-a', 'ADMIN');
  const b = await makeBooking(c, w, 'CONFIRMED');
  await setStatus(w.token, b.id, 'DISPATCHED');
  await sendFix(w.token, b.id, { latitude: 15.876543, longitude: 74.497711, accuracy: 9 });

  for (const [who, name] of [[other, 'another customer'], [w2, 'an unassigned worker'], [admin, 'an admin']]) {
    const r = await api('GET', `/api/bookings/${b.id}/tracking`, { token: who.token });
    assert.equal(r.status, 403, name);
    assert.equal(JSON.stringify(r.data).includes('15.8765'), false);
  }
  assert.equal((await api('GET', `/api/bookings/${b.id}/tracking`)).status, 401);
  assert.equal((await api('GET', '/api/bookings/00000000-0000-0000-0000-000000000000/tracking', { token: c.token })).status, 404);

  // coordinates are not in any booking payload, for either participant
  const payloads = [
    (await api('GET', '/api/bookings/my', { token: c.token })).data, (await api('GET', '/api/bookings/my', { token: w.token })).data,
    (await api('GET', `/api/bookings/${b.id}`, { token: c.token })).data, (await api('GET', `/api/bookings/${b.id}`, { token: w.token })).data,
    (await setStatus(w.token, b.id, 'DISPATCHED')).data
  ];
  for (const p of payloads) {
    const text = JSON.stringify(p);
    assert.equal(/trackLatitude|trackLongitude|trackAccuracy|trackUpdatedAt/.test(text), false, 'no journey fields in booking payloads');
    assert.equal(text.includes('15.876543') || text.includes('74.497711'), false, 'no worker coordinates in booking payloads');
  }
  const mine = (await api('GET', '/api/bookings/my', { token: c.token })).data.bookings.find((x) => x.id === b.id);
  assert.equal(mine.journeyStatus, 'JOURNEY_STARTED');

  // public worker profile and discovery never carry the journey position
  const pub = JSON.stringify([(await api('GET', `/api/users/workers/${w.user.id}`)).data, (await api('GET', '/api/users/workers?limit=50')).data]);
  assert.equal(pub.includes('15.876543') || pub.includes('74.497711'), false);
});

test('tracking is unavailable for requested, cancelled, disputed and completed bookings; cancellation erases the stored position', async () => {
  const c = await makeUser('st-c', 'CUSTOMER'); const w = await makeWorker('st-w');
  for (const status of ['REQUESTED', 'CANCELLED', 'DISPUTED', 'COMPLETED']) {
    const b = await makeBooking(c, w, status, { trackLatitude: 15.9, trackLongitude: 74.5, trackAccuracy: 10, trackUpdatedAt: new Date() }); // leftover data must not be shown
    const t = await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token });
    assert.equal(t.status, 200);
    assert.equal(t.data.tracking.sharing, false, status); assert.equal(t.data.tracking.location, null, `${status}: no position is exposed`);
    const sendNow = await api('POST', `/api/bookings/${b.id}/location`, { token: w.token, json: { ...NEAR, accuracy: 10 } });
    assert.equal(sendNow.status, 409, status);
  }
  // cancelling mid-journey
  const b = await makeBooking(c, w, 'CONFIRMED');
  await setStatus(w.token, b.id, 'DISPATCHED');
  await sendFix(w.token, b.id, { ...NEAR, accuracy: 10 });
  assert.ok((await booking(b.id)).trackLatitude != null);
  assert.equal((await setStatus(c.token, b.id, 'CANCELLED')).status, 200);
  const row = await booking(b.id);
  assert.deepEqual([row.trackLatitude, row.trackLongitude, row.trackUpdatedAt], [null, null, null]);
  assert.equal(activeTracking.has(b.id), false, 'live session is gone');
  assert.equal((await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token })).data.tracking.location, null);
});

// ─── Real-time over Socket.IO ───────────────────────────────────────────────

test('customer receives the worker\'s location live; authorization is enforced on every socket event', async () => {
  const c = await makeUser('s-c', 'CUSTOMER'); const w = await makeWorker('s-w');
  const other = await makeUser('s-o', 'CUSTOMER'); const w2 = await makeWorker('s-w2'); const admin = await makeUser('s-a', 'ADMIN');
  const b = await makeBooking(c, w, 'CONFIRMED');
  const cs = connect(c.token); const ws = connect(w.token);
  await Promise.all([cs.ready(), ws.ready()]);

  // before the journey: subscribing works for status updates, but there is no location
  let sub = await cs.emit('tracking:subscribe', { bookingId: b.id });
  assert.equal(sub.ok, true); assert.equal(sub.tracking.sharing, false);
  const st0 = await cs.when('tracking:state');
  assert.equal(st0.active, false); assert.equal(st0.lastLocation, null); assert.match(st0.message, /starts when the professional begins/i);
  assert.equal((await ws.emit('tracking:update', { bookingId: b.id, ...NEAR, accuracy: 10 })).code, 'NOT_TRACKING');
  await settle(100);
  assert.equal(cs.count('tracking:location'), 0);

  // the worker explicitly starts the journey; the customer sees the status change live
  assert.equal((await setStatus(w.token, b.id, 'DISPATCHED')).status, 200);
  const changed = await cs.when('booking:status:changed', (p) => p.status === 'DISPATCHED');
  assert.equal(changed.journeyStatus, 'JOURNEY_STARTED');
  assert.equal((await ws.emit('booking:join', { bookingId: b.id })).ok, true);
  const upd = await ws.emit('worker:location:update', { bookingId: b.id, ...NEAR, accuracy: 14, timestamp: Date.now() });
  assert.equal(upd.ok, true); assert.equal(upd.accepted, true);
  const live = await cs.when('tracking:location');
  assert.equal(live.location.latitude, NEAR.latitude); assert.equal(live.location.accuracy, 14);
  assert.equal(live.freshness, 'live'); assert.equal(live.journeyStatus, 'JOURNEY_STARTED'); assert.equal(live.eta, null);
  assert.ok(Math.abs(live.distanceKm - 3.0) < 0.1);
  assert.equal(cs.count('tracking:location'), 1);
  assert.equal(ws.count('tracking:location') >= 1, true, 'the worker is in the room too');

  // unauthorized people: refused on join, on updates, and they receive nothing
  const intruders = [];
  for (const who of [other, w2, admin]) {
    const s = connect(who.token); await s.ready();
    const j = await s.emit('tracking:subscribe', { bookingId: b.id });
    assert.equal(j.ok, false); assert.equal(j.code, 'FORBIDDEN');
    assert.equal((await s.emit('booking:join', { bookingId: b.id })).code, 'FORBIDDEN');
    assert.equal((await s.emit('worker:location:update', { bookingId: b.id, latitude: 1, longitude: 1, accuracy: 5 })).code, 'FORBIDDEN');
    intruders.push(s);
  }
  assert.equal((await cs.emit('worker:location:update', { bookingId: b.id, ...NEAR, accuracy: 5 })).code, 'FORBIDDEN', 'the customer cannot send positions');
  bump(b.id);
  await ws.emit('worker:location:update', { bookingId: b.id, latitude: NEAR.latitude + 0.0003, longitude: NEAR.longitude, accuracy: 9 });
  await settle(250);
  for (const s of intruders) { assert.equal(s.count('tracking:location'), 0); assert.equal(JSON.stringify(s.received).includes(String(NEAR.latitude)), false); }
  const nobody = connect(null, { reconnection: false });
  await assert.rejects(nobody.ready(), /missing token/);
  assert.equal(await prisma.booking.count({ where: { id: b.id, trackLatitude: { not: null } } }), 1);

  // arrival ends it for the customer's screen
  assert.equal((await api('POST', `/api/bookings/${b.id}/arrive`, { token: w.token })).status, 200);
  const stopped = await cs.when('tracking:stopped');
  assert.match(stopped.message, /arrived/i);
  const arrivedEvt = await cs.when('booking:status:changed', (p) => p.journeyStatus === 'WORKER_ARRIVED');
  assert.equal(arrivedEvt.bookingId, b.id);
  bump(b.id);
  assert.equal((await ws.emit('worker:location:update', { bookingId: b.id, ...NEAR, accuracy: 5 })).code, 'NOT_TRACKING');
});

test('subscribing to a completed or cancelled booking is refused', async () => {
  const c = await makeUser('na-c', 'CUSTOMER'); const w = await makeWorker('na-w');
  const done = await makeBooking(c, w, 'COMPLETED'); const gone = await makeBooking(c, w, 'CANCELLED'); const asked = await makeBooking(c, w, 'REQUESTED');
  const cs = connect(c.token); await cs.ready();
  for (const b of [done, gone, asked]) {
    const r = await cs.emit('tracking:subscribe', { bookingId: b.id });
    assert.equal(r.ok, false); assert.equal(r.code, 'NOT_ACTIVE');
  }
  assert.equal((await cs.emit('tracking:subscribe', { bookingId: { $ne: 1 } })).ok, false);
  assert.equal((await cs.emit('tracking:subscribe', {})).ok, false);
});

test('stale handling: a worker whose page closed is shown as not live, with the last update kept; resuming is announced', async () => {
  const c = await makeUser('sl-c', 'CUSTOMER'); const w = await makeWorker('sl-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  await setStatus(w.token, b.id, 'DISPATCHED');
  const cs = connect(c.token); let ws = connect(w.token);
  await Promise.all([cs.ready(), ws.ready()]);
  await cs.emit('tracking:subscribe', { bookingId: b.id });
  await ws.emit('tracking:subscribe', { bookingId: b.id });
  assert.equal((await ws.emit('tracking:update', { bookingId: b.id, ...NEAR, accuracy: 10 })).accepted, true);
  await cs.when('tracking:location');

  // the worker's browser is closed (connection lost)
  ws.close();
  const stale = await cs.when('tracking:stale');
  assert.equal(stale.reason, 'worker_disconnected');
  assert.match(stale.message, /last known position/i);
  assert.ok(stale.lastUpdated);
  assert.equal(cs.count('tracking:stopped'), 0, 'it is not reported as a clean stop');
  let t = await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token });
  assert.equal(t.data.tracking.location.latitude, NEAR.latitude, 'the last successful position is still available');
  assert.equal(t.data.tracking.sharing, true);

  // the server's own clock decides staleness for a worker that vanished without a disconnect
  const st = activeTracking.get(b.id);
  st.staleNotified = false; st.status = 'ACTIVE'; st.lastAcceptedAt = Date.now() - 5 * 60 * 1000; st.lastUpdated = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert.equal(tracking.sweepStale(), 1);
  const swept = await cs.when('tracking:stale', (e) => e.reason === 'no_updates');
  assert.match(swept.message, /stopped/i);
  assert.equal(tracking.sweepStale(), 0, 'announced once, not repeatedly');
  t = await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token });
  assert.equal(t.data.tracking.freshness, 'stale', 'freshness reflects the age of the update, not the connection');
  assert.equal(t.data.tracking.distanceKm, null, 'no distance is claimed from an old position');

  // the worker comes back: the page reconnects, rejoins and the next fix resumes live tracking
  ws = connect(w.token); await ws.ready();
  await ws.emit('tracking:subscribe', { bookingId: b.id });
  bump(b.id);
  assert.equal((await ws.emit('tracking:update', { bookingId: b.id, latitude: NEAR.latitude - 0.001, longitude: NEAR.longitude, accuracy: 10 })).accepted, true);
  await cs.when('tracking:resumed');
  const back = await cs.when('tracking:location', (p) => p.location.latitude < NEAR.latitude);
  assert.equal(back.freshness, 'live');
});

test('the journey survives a server restart and a customer reconnect (last position is stored)', async () => {
  const c = await makeUser('rs-c', 'CUSTOMER'); const w = await makeWorker('rs-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  await setStatus(w.token, b.id, 'DISPATCHED');
  await sendFix(w.token, b.id, { ...NEAR, accuracy: 15 });
  activeTracking.clear(); // what a restart does to in-memory state
  const t = await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token });
  assert.equal(t.data.tracking.location.latitude, NEAR.latitude);
  assert.ok(['live', 'delayed'].includes(t.data.tracking.freshness));
  // an old stored position is reported as stale, however recent the page load
  await prisma.booking.update({ where: { id: b.id }, data: { trackUpdatedAt: new Date(Date.now() - 30 * 60 * 1000) } });
  assert.equal((await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token })).data.tracking.freshness, 'stale');

  // customer's connection drops and returns: resubscribing returns the state again
  const cs = connect(c.token); await cs.ready();
  await cs.emit('tracking:subscribe', { bookingId: b.id });
  const dropped = new Promise((resolve) => cs.socket.once('disconnect', resolve));
  const back = new Promise((resolve) => cs.socket.once('connect', resolve));
  cs.socket.io.engine.transport.ws.close();
  await dropped; await back;
  const again = await cs.emit('tracking:subscribe', { bookingId: b.id });
  assert.equal(again.ok, true); assert.equal(again.tracking.location.latitude, NEAR.latitude);
  assert.equal(again.tracking.freshness, 'stale');
});

test('revoked sessions stop receiving and sending tracking', async () => {
  const c = await makeUser('rv-c', 'CUSTOMER'); const w = await makeWorker('rv-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  await setStatus(w.token, b.id, 'DISPATCHED');

  const cs = connect(c.token, { reconnection: false }); const ws = connect(w.token, { reconnection: false });
  await Promise.all([cs.ready(), ws.ready()]);
  await cs.emit('tracking:subscribe', { bookingId: b.id }); await ws.emit('tracking:subscribe', { bookingId: b.id });
  // logout drops the customer's socket; they receive nothing further
  const closed = new Promise((resolve) => cs.socket.once('disconnect', resolve));
  await api('POST', '/api/auth/logout', { token: c.token });
  await closed;
  await ws.emit('tracking:update', { bookingId: b.id, ...NEAR, accuracy: 10 });
  await settle(200);
  assert.equal(cs.count('tracking:location'), 0);
  const again = connect(c.token, { reconnection: false });
  await assert.rejects(again.ready(), /session is no longer valid/);

  // a session revoked behind the server's back is refused on the next tracking event
  await prisma.user.update({ where: { id: w.user.id }, data: { tokenVersion: { increment: 1 } } });
  bump(b.id);
  const dropped = new Promise((resolve) => ws.socket.once('disconnect', resolve));
  const r = await ws.emit('tracking:update', { bookingId: b.id, latitude: NEAR.latitude + 0.0002, longitude: NEAR.longitude, accuracy: 10 });
  assert.equal(r.ok, false); assert.equal(r.code, 'SESSION_REVOKED');
  await dropped;
  const before = (await booking(b.id)).trackLatitude;
  assert.equal(before, NEAR.latitude, 'the revoked update was not stored');
});

test('a paused worker is shown as not live (not as stopped); the newest position is stored even when updates are throttled', async () => {
  const c = await makeUser('pz-c', 'CUSTOMER'); const w = await makeWorker('pz-w');
  const b = await makeBooking(c, w, 'CONFIRMED');
  await setStatus(w.token, b.id, 'DISPATCHED');
  const cs = connect(c.token); const ws = connect(w.token);
  await Promise.all([cs.ready(), ws.ready()]);
  await cs.emit('tracking:subscribe', { bookingId: b.id }); await ws.emit('tracking:subscribe', { bookingId: b.id });

  // two quick accepted fixes: only the first is written immediately (10 s write throttle)...
  assert.equal((await ws.emit('tracking:update', { bookingId: b.id, ...NEAR, accuracy: 10 })).accepted, true);
  bump(b.id);
  const newer = { latitude: NEAR.latitude - 0.0003, longitude: NEAR.longitude };
  assert.equal((await ws.emit('tracking:update', { bookingId: b.id, ...newer, accuracy: 10 })).accepted, true);
  assert.equal((await booking(b.id)).trackLatitude, NEAR.latitude, 'the second fix is still waiting to be written');
  // ...and the trailing write catches up once the write interval has passed
  assert.equal(await tracking.flushPending(Date.now() + 11000), 1);
  assert.ok(Math.abs((await booking(b.id)).trackLatitude - newer.latitude) < 1e-9, 'the stored position is the latest one');
  assert.equal(await tracking.flushPending(Date.now() + 22000), 0, 'nothing left to write');

  // the worker pauses sharing
  await ws.emit('tracking:stop', { bookingId: b.id });
  const paused = await cs.when('tracking:stale');
  assert.equal(paused.reason, 'worker_paused'); assert.match(paused.message, /paused/i);
  assert.equal(cs.count('tracking:stopped'), 0, 'a pause is not an end of tracking');
  let t = await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token });
  assert.equal(t.data.tracking.paused, true); assert.equal(t.data.tracking.sharing, true);
  assert.ok(t.data.tracking.location, 'the last position remains');
  // resuming flips it back
  await ws.emit('tracking:subscribe', { bookingId: b.id });
  bump(b.id);
  assert.equal((await ws.emit('tracking:update', { bookingId: b.id, latitude: newer.latitude - 0.0003, longitude: newer.longitude, accuracy: 10 })).accepted, true);
  await cs.when('tracking:resumed');
  t = await api('GET', `/api/bookings/${b.id}/tracking`, { token: c.token });
  assert.equal(t.data.tracking.paused, false);
});
