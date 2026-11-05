// Customer marketplace: discovery filters/sorts/pagination, privacy of worker data, homepage data,
// suggestions, portfolio and booking problem description. Real Express routes + real PostgreSQL/PostGIS.
// Supabase Storage is replaced by an in-memory fake (portfolio uploads only).
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const prisma = require('../config/prisma');
const supabaseConfig = require('../config/supabase');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');

const tag = `mk${Date.now()}`;
const created = { users: [], categories: [], items: [] };
let base;
let cat;
let otherCat;

// ── Fake public image storage ────────────────────────────────────────────────
const objects = new Map();
const originalAdmin = supabaseConfig.supabaseAdmin;
supabaseConfig.supabaseAdmin = {
  storage: {
    from: (bucket) => ({
      upload: async (path, buffer) => { objects.set(`${bucket}/${path}`, buffer); return { data: { path }, error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://img.test/${bucket}/${path}` } }),
      remove: async (paths) => { paths.forEach((p) => objects.delete(`${bucket}/${p}`)); return { data: {}, error: null }; }
    })
  }
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function api(method, route, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(base + route, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}

async function makeUser(label, role, extra = {}) {
  const user = await prisma.user.create({
    data: { email: `${tag}.${label}@example.com`, name: `${tag} ${label}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210', ...extra }
  });
  created.users.push(user.id);
  return { user, token: signSessionToken(user) };
}

// A discoverable worker in the test category. lat/lng offsets are degrees from (15.85, 74.51).
async function makeWorker(label, o = {}) {
  const w = await makeUser(label, 'WORKER', { avatarUrl: o.avatarUrl === undefined ? 'https://img.test/a.jpg' : o.avatarUrl, isActive: o.isActive !== false });
  const profile = await prisma.workerProfile.create({
    data: {
      userId: w.user.id, primaryCategoryId: (o.category || cat).id, verificationStatus: o.status || 'VERIFIED',
      hourlyRate: o.hourly ?? 300, inspectionFee: o.visit ?? 0, experienceYears: o.years ?? 2, bio: o.bio || 'Reliable local professional.',
      rating: o.rating ?? 0, reviewsCount: o.reviews ?? 0, city: 'Belagavi', locality: 'Tilakwadi',
      serviceAddress: '221B Secret Lane, Flat 9, Belagavi 590006', languages: ['English'],
      skills: o.skills ? { create: o.skills.map((skillName) => ({ skillName })) } : undefined,
      availabilities: o.hours ? { create: o.hours } : undefined
    }
  });
  if (o.location !== false) {
    await prisma.workerLocation.create({
      data: {
        workerProfileId: profile.id, latitude: 15.85 + (o.dLat || 0), longitude: 74.51 + (o.dLng || 0),
        lastLocationUpdate: o.stale ? new Date(Date.now() - 3600 * 1000) : new Date(), isAvailable: o.available !== false, sharingEnabled: o.sharing !== false
      }
    });
  }
  return { ...w, profile };
}

const list = async (query, token) => (await api('GET', `/api/users/workers?category=${cat.slug}&${query}`, { token })).data;
const names = (res) => res.workers.map((w) => w.name.replace(`${tag} `, ''));

test.before(async () => {
  cat = await prisma.serviceCategory.create({ data: { name: `Cat ${tag}`, slug: `cat-${tag}`, description: 'Test category' } });
  otherCat = await prisma.serviceCategory.create({ data: { name: `Other ${tag}`, slug: `other-${tag}` } });
  created.categories.push(cat.id, otherCat.id);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  supabaseConfig.supabaseAdmin = originalAdmin;
  await prisma.review.deleteMany({ where: { workerId: { in: created.users } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { OR: [{ workerId: { in: created.users } }, { customerId: { in: created.users } }] } }).catch(() => {});
  await prisma.serviceItem.deleteMany({ where: { id: { in: created.items } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created.users } } }).catch(() => {});
  await prisma.serviceCategory.deleteMany({ where: { id: { in: created.categories } } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ── Discovery ────────────────────────────────────────────────────────────────

test('discovery excludes pending, rejected, unverified, offline, stale and inactive workers', async () => {
  await makeWorker('ok-1');
  for (const [label, o] of Object.entries({
    pending: { status: 'PENDING_REVIEW' }, rejected: { status: 'REJECTED' }, unverified: { status: 'UNVERIFIED' },
    offline: { available: false }, nosharing: { sharing: false }, stale: { stale: true }, nolocation: { location: false }, inactive: { isActive: false }
  })) await makeWorker(`x-${label}`, o);

  const res = await list('limit=50');
  assert.deepEqual(names(res), ['ok-1']);
  assert.equal(res.total, 1);
});

test('filters: rating, price, experience, reviewedOnly all work on real data', async () => {
  const c = await makeUser('f-cust', 'CUSTOMER');
  await makeWorker('f-top', { rating: 4.8, reviews: 20, hourly: 600, years: 12 });
  await makeWorker('f-mid', { rating: 4.0, reviews: 5, hourly: 300, years: 5 });
  await makeWorker('f-new', { rating: 0, reviews: 0, hourly: 150, years: 1 });
  await makeWorker('f-visit', { hourly: 0, visit: 200, years: 3 }); // quoted by visit charge only

  const all = await list('limit=50&sort=price', c.token);
  assert.deepEqual(names(all).filter((n) => n.startsWith('f-')), ['f-new', 'f-visit', 'f-mid', 'f-top'], 'lowest price first, visit-only worker priced at 200');

  assert.deepEqual(names(await list('minRating=4.5')).filter((n) => n.startsWith('f-')), ['f-top']);
  assert.deepEqual(names(await list('minRating=4&sort=rating')).filter((n) => n.startsWith('f-')), ['f-top', 'f-mid'], 'unreviewed workers never satisfy a rating filter');
  assert.deepEqual(names(await list('maxPrice=250&sort=price')).filter((n) => n.startsWith('f-')), ['f-new', 'f-visit']);
  assert.deepEqual(names(await list('minExperience=5&sort=experience')).filter((n) => n.startsWith('f-')), ['f-top', 'f-mid']);
  assert.deepEqual(names(await list('reviewedOnly=true&sort=rating')).filter((n) => n.startsWith('f-')), ['f-top', 'f-mid']);
  // unreviewed workers sort after reviewed ones when ordering by rating
  const byRating = names(await list('sort=rating&limit=50')).filter((n) => n.startsWith('f-'));
  assert.deepEqual(byRating.slice(0, 2), ['f-top', 'f-mid']);
  const ex = names(await list('sort=experience&limit=50')).filter((n) => n.startsWith('f-'));
  assert.deepEqual(ex.slice(0, 2), ['f-top', 'f-mid']);
  // validation
  assert.equal((await api('GET', '/api/users/workers?minRating=9')).status, 400);
  assert.equal((await api('GET', '/api/users/workers?sort=nearest')).status, 400, 'nearest needs a location');
  assert.equal((await api('GET', '/api/users/workers?sort=banana')).status, 400);
  assert.equal((await api('GET', '/api/users/workers?availability=now')).status, 400, 'needs day and time');
});

test('availability filter uses the worker\'s real working hours', async () => {
  const mon = (start, end) => [{ dayOfWeek: 1, startTime: start, endTime: end, isActive: true }];
  await makeWorker('h-morning', { hours: mon('08:00', '12:00') });
  await makeWorker('h-day', { hours: mon('09:00', '18:00') });
  await makeWorker('h-sunday', { hours: [{ dayOfWeek: 0, startTime: '09:00', endTime: '18:00', isActive: true }] });
  await makeWorker('h-nohours');

  const today = names(await list('availability=today&day=1&sort=rating&limit=50')).filter((n) => n.startsWith('h-')).sort();
  assert.deepEqual(today, ['h-day', 'h-morning'], 'only workers with Monday hours; no-hours workers are NOT assumed available');
  const now10 = names(await list('availability=now&day=1&time=10:00&limit=50')).filter((n) => n.startsWith('h-')).sort();
  assert.deepEqual(now10, ['h-day', 'h-morning']);
  const now15 = names(await list('availability=now&day=1&time=15:00&limit=50')).filter((n) => n.startsWith('h-'));
  assert.deepEqual(now15, ['h-day']);
  const sun = names(await list('availability=today&day=0&limit=50')).filter((n) => n.startsWith('h-'));
  assert.deepEqual(sun, ['h-sunday']);
});

test('distance: radius filter, nearest sort, coarse 0.5 km distances and no private coordinates', async () => {
  await makeWorker('d-near', { dLat: 0.005 });  // ~0.55 km
  await makeWorker('d-mid', { dLat: 0.05 });    // ~5.5 km
  await makeWorker('d-far', { dLat: 0.5 });     // ~55 km
  const q = 'lat=15.85&lng=74.51&sort=nearest&limit=50';
  const within10 = await list(`${q}&radiusKm=10`);
  assert.deepEqual(names(within10).filter((n) => n.startsWith('d-')), ['d-near', 'd-mid']);
  const within100 = await list(`${q}&radiusKm=100`);
  assert.deepEqual(names(within100).filter((n) => n.startsWith('d-')), ['d-near', 'd-mid', 'd-far']);
  for (const w of within100.workers) {
    assert.equal((w.distanceKm * 2) % 1, 0, `distance ${w.distanceKm} is a multiple of 0.5 km`);
    assert.ok(w.distanceKm >= 0.5);
    assert.ok(!('latitude' in w) && !('longitude' in w));
    assert.equal('mapLocation' in w, false, 'no public map pin');
    assert.equal(typeof w.serviceArea === 'string' || w.serviceArea === null, true, 'locality is shown instead');
  }
});

test('pagination returns correct pages and the true total', async () => {
  for (let i = 1; i <= 5; i += 1) await makeWorker(`p-${i}`, { years: i });
  const p1 = await list('q=p-&sort=experience&limit=2&page=1');
  const p2 = await list('q=p-&sort=experience&limit=2&page=2');
  const p3 = await list('q=p-&sort=experience&limit=2&page=3');
  assert.equal(p1.total, 5);
  assert.deepEqual(names(p1), ['p-5', 'p-4']);
  assert.deepEqual(names(p2), ['p-3', 'p-2']);
  assert.deepEqual(names(p3), ['p-1']);
});

test('search matches worker name, skills and catalog service keywords; additional categories are included', async () => {
  const item = await prisma.serviceItem.create({ data: { categoryId: cat.id, title: `Quantum Widget Fitting ${tag}`, slug: `qw-${tag}`, basePrice: 250 } });
  created.items.push(item.id);
  await makeWorker('s-named', { skills: ['Tile grouting'] });
  const extra = await makeWorker('s-extra', { category: otherCat });
  await prisma.workerProfileCategory.create({ data: { workerProfileId: extra.profile.id, categoryId: cat.id } });

  assert.ok(names(await list('q=s-named')).includes('s-named'), 'by name');
  assert.ok(names(await list('q=grouting')).includes('s-named'), 'by skill');
  assert.ok(names(await list('q=widget')).includes('s-named'), 'by catalog service keyword (maps to the category)');
  assert.deepEqual(names(await list('q=zzzznothing')), []);
  assert.ok(names(await list('q=s-extra')).includes('s-extra'), 'a worker serving the category as an additional category is listed under it');
  // LIKE wildcards in user input are treated literally
  assert.deepEqual(names(await list('q=%25')), []);
});

// ── Privacy / worker payload ─────────────────────────────────────────────────

test('worker payloads never expose email, phone, street address or generated avatars', async () => {
  const w = await makeWorker('pv-1', { avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Fake', hours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isActive: true }] });
  const listing = (await list('q=pv-1')).workers[0];
  const profile = (await api('GET', `/api/users/workers/${w.user.id}`)).data.worker;
  for (const payload of [listing, profile]) {
    const json = JSON.stringify(payload);
    assert.ok(!json.includes(w.user.email), 'no email');
    assert.ok(!json.includes('98765'), 'no phone');
    assert.ok(!json.includes('Secret Lane') && !json.includes('Flat 9'), 'no street address');
    assert.equal(payload.avatarUrl, null, 'a generated cartoon is not a profile photo');
    assert.equal(payload.serviceArea, 'Tilakwadi, Belagavi');
    assert.equal(payload.startingPrice, 300);
    assert.equal(payload.priceUnit, 'hour');
    assert.equal(payload.rating, null);
    assert.equal(payload.reviewsCount, 0);
  }
  assert.deepEqual(profile.workingHours, [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }]);
  assert.equal(profile.availableNow, true);
  // the worker's own response still carries their contact details
  const own = await api('PUT', '/api/users/profile', { token: w.token, json: { bio: 'Updated bio for the worker.' } });
  assert.equal(own.data.user.email, w.user.email);
});

test('availability reflects the worker\'s real sharing state on the public profile', async () => {
  const w = await makeWorker('av-1', { available: false });
  const profile = (await api('GET', `/api/users/workers/${w.user.id}`)).data.worker;
  assert.equal(profile.availableNow, false);
  assert.equal(profile.availability, 'Not available right now');
});

// ── Homepage data & suggestions ──────────────────────────────────────────────

test('home: categories carry live availability counts that respond to location; services are labelled honestly', async () => {
  // a dedicated category so the counts are exact regardless of other tests' workers
  const homeCat = await prisma.serviceCategory.create({ data: { name: `Home ${tag}`, slug: `home-${tag}` } });
  created.categories.push(homeCat.id);
  await makeWorker('home-near', { dLat: 0.005, category: homeCat });
  await makeWorker('home-far', { dLat: 0.5, category: homeCat });
  const anon = (await api('GET', '/api/marketplace/home')).data;
  const mine = (id, res) => res.categories.find((c) => c.id === id);
  assert.equal(mine(homeCat.id, anon).availableWorkers, 2);
  const emptyCat = await prisma.serviceCategory.create({ data: { name: `Empty ${tag}`, slug: `empty-${tag}` } });
  created.categories.push(emptyCat.id);
  const anon2 = (await api('GET', '/api/marketplace/home')).data;
  assert.equal(mine(emptyCat.id, anon2).availableWorkers, 0, 'a category with nobody available shows 0, not an invented number');
  assert.ok(['Painter', 'Plumber', 'Electrician', 'Tutor', 'AC Repair', 'Beauty Services'].every((n) => anon.categories.some((c) => c.name === n)), 'database-driven taxonomy');
  const nearby = (await api('GET', '/api/marketplace/home?lat=15.85&lng=74.51&radiusKm=10')).data;
  assert.equal(nearby.locationApplied, true);
  assert.equal(mine(homeCat.id, nearby).availableWorkers, 1, 'only the worker inside the radius is counted');
  assert.deepEqual(anon.bookAgain, [], 'no personalisation without a logged-in customer');
  assert.ok(['popular', 'catalog'].includes(anon.servicesSource));
  assert.equal((await api('GET', '/api/marketplace/home?lat=15.85')).status, 400);
});

test('home: popular services come from real bookings; book-again comes from the customer\'s own history', async () => {
  const w = await makeWorker('bk-w');
  const c = await makeUser('bk-cust', 'CUSTOMER');
  const item = await prisma.serviceItem.create({ data: { categoryId: cat.id, title: `Popular thing ${tag}`, slug: `pop-${tag}`, basePrice: 500 } });
  created.items.push(item.id);
  for (let i = 0; i < 3; i += 1) {
    await prisma.booking.create({ data: { bookingNumber: `BK-${tag}-${i}`, customerId: c.user.id, workerId: w.user.id, serviceItemId: item.id, status: 'COMPLETED', scheduledAt: new Date(Date.now() - 86400000), agreedPrice: 500 } });
  }
  const res = (await api('GET', '/api/marketplace/home', { token: c.token })).data;
  assert.equal(res.servicesSource, 'popular');
  assert.equal(res.services[0].id, item.id);
  assert.equal(res.services[0].bookings, 3);
  assert.equal(res.bookAgain[0].category.id, cat.id);
  assert.equal(res.bookAgain[0].times, 3);
  // another customer sees no book-again history
  const other = await makeUser('bk-other', 'CUSTOMER');
  assert.deepEqual((await api('GET', '/api/marketplace/home', { token: other.token })).data.bookAgain, []);
});

test('suggest: categories, services and ONLY approved workers', async () => {
  await makeWorker('sg-good');
  await makeWorker('sg-pending', { status: 'PENDING_REVIEW' });
  const res = (await api('GET', `/api/marketplace/suggest?q=${encodeURIComponent('sg-')}`)).data;
  assert.deepEqual(res.workers.map((w) => w.name.replace(`${tag} `, '')), ['sg-good']);
  const cats = (await api('GET', '/api/marketplace/suggest?q=plumb')).data;
  assert.ok(cats.categories.some((c) => c.name === 'Plumber'));
  assert.deepEqual((await api('GET', '/api/marketplace/suggest?q=a')).data, { success: true, categories: [], services: [], workers: [] }, 'under 2 characters: nothing');
});

// ── Portfolio ────────────────────────────────────────────────────────────────

test('portfolio: worker uploads real photos, they appear on the verified public profile, others cannot touch them', async () => {
  const w = await makeWorker('pf-1');
  const stranger = await makeWorker('pf-2');
  const form = (buffer, name = 'work.png', type = 'image/png', caption = 'Kitchen sink fitted') => {
    const f = new FormData();
    f.append('photo', new Blob([buffer], { type }), name);
    f.append('caption', caption);
    return f;
  };
  let r = await api('POST', '/api/worker/portfolio', { token: w.token, form: form(Buffer.from('not an image at all, just text bytes here'), 'x.png') });
  assert.equal(r.status, 400, 'content is validated, not the file extension');
  r = await api('POST', '/api/worker/portfolio', { token: w.token, form: form(PNG, 'a.pdf', 'application/pdf') });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/worker/portfolio', { token: w.token, form: form(PNG) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const item = r.data.item;
  assert.match(item.url, /^https:\/\/img\.test\/profile-photos\/.+\/portfolio-.+\.png$/);

  const profile = (await api('GET', `/api/users/workers/${w.user.id}`)).data.worker;
  assert.deepEqual(profile.portfolio.map((p) => p.caption), ['Kitchen sink fitted']);

  assert.equal((await api('DELETE', `/api/worker/portfolio/${item.id}`, { token: stranger.token })).status, 404);
  assert.equal((await api('GET', '/api/worker/portfolio', { token: stranger.token })).data.items.length, 0);
  assert.equal((await api('DELETE', `/api/worker/portfolio/${item.id}`, { token: w.token })).status, 200);
  assert.equal((await api('GET', `/api/users/workers/${w.user.id}`)).data.worker.portfolio.length, 0);

  // customers cannot use the worker endpoints
  const c = await makeUser('pf-cust', 'CUSTOMER');
  assert.equal((await api('POST', '/api/worker/portfolio', { token: c.token, form: form(PNG) })).status, 403);

  // an unapproved worker's portfolio is not public
  const pending = await makeWorker('pf-3', { status: 'PENDING_REVIEW' });
  assert.equal((await api('POST', '/api/worker/portfolio', { token: pending.token, form: form(PNG) })).status, 201);
  assert.equal((await api('GET', `/api/users/workers/${pending.user.id}`)).status, 404);
});

test('portfolio is capped at 12 photos', async () => {
  const w = await makeWorker('pf-cap');
  for (let i = 0; i < 12; i += 1) {
    const f = new FormData(); f.append('photo', new Blob([PNG], { type: 'image/png' }), `w${i}.png`);
    assert.equal((await api('POST', '/api/worker/portfolio', { token: w.token, form: f })).status, 201);
  }
  const f = new FormData(); f.append('photo', new Blob([PNG], { type: 'image/png' }), 'extra.png');
  assert.equal((await api('POST', '/api/worker/portfolio', { token: w.token, form: f })).status, 400);
});

// ── Booking request ──────────────────────────────────────────────────────────

test('booking stores the customer\'s problem description and still enforces verification', async () => {
  const good = await makeWorker('bq-good');
  const bad = await makeWorker('bq-bad', { status: 'PENDING_REVIEW' });
  const c = await makeUser('bq-cust', 'CUSTOMER');
  const when = new Date(Date.now() + 2 * 86400000).toISOString();

  let r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: good.user.id, scheduledAt: when, timeSlot: '10:00 - 12:00', agreedPrice: 300, problemDescription: 'Kitchen tap is leaking under the sink.' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.booking.status, 'REQUESTED', 'a request, never an automatic confirmation');
  assert.equal(r.data.booking.problemDescription, 'Kitchen tap is leaking under the sink.');
  const saved = await prisma.booking.findUnique({ where: { id: r.data.booking.id } });
  assert.equal(saved.problemDescription, 'Kitchen tap is leaking under the sink.');
  assert.equal(await prisma.payment.count({ where: { bookingId: saved.id } }), 0, 'no payment is created or marked successful');

  // worker sees it in their bookings
  const mine = await api('GET', '/api/bookings/my', { token: good.token });
  assert.equal(mine.data.bookings[0].problemDescription, 'Kitchen tap is leaking under the sink.');

  r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: good.user.id, scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString(), agreedPrice: 300, problemDescription: 'x'.repeat(1001) } });
  assert.equal(r.status, 400);
  r = await api('POST', '/api/bookings', { token: c.token, json: { workerId: bad.user.id, scheduledAt: when, agreedPrice: 300, problemDescription: 'Please help with this.' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'WORKER_NOT_VERIFIED');
});

test('a generated cartoon avatar no longer satisfies the onboarding photo requirement', async () => {
  const w = await makeUser('av-onb', 'WORKER', { avatarUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Fake' });
  const r = await api('PUT', '/api/worker/onboarding/step/1', {
    token: w.token,
    json: { complete: true, data: { fullName: 'Ravi Kumar', phone: '+91 98765 11111', city: 'Belagavi', locality: 'Tilakwadi', address: '14th Cross, Tilakwadi, Belagavi' } }
  });
  assert.equal(r.status, 400);
  assert.ok(r.data.errors.photo);
  const state = await api('GET', '/api/worker/onboarding', { token: w.token });
  assert.equal(state.data.onboarding.account.avatarUrl, null);
});
