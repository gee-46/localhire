// LocalHire location + journey tracking (browser side).
//
// What this module can and cannot do, honestly:
//  * It uses the browser Geolocation API. Browsers only deliver positions while the page is open and the device is
//    awake; when the tab is closed, the phone locks, or the OS suspends the browser, updates stop. The server then
//    marks the location stale and customers see the last update with its age, never a false "live" status.
//    Reliable background tracking needs a native Android/iOS app (see README).
//  * Nothing here invents a position, a distance or an arrival time.
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = () => window.LocalHireNotify;
  const call = (m, p, b) => N().call(m, p, b);

  // ── Leaflet (loaded on demand, pinned version with integrity hashes) ──────
  let leafletLoading = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (leafletLoading) return leafletLoading;
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; css.crossOrigin = '';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; s.crossOrigin = '';
      s.onload = () => (window.L ? resolve(window.L) : reject(new Error('Map library did not start.')));
      s.onerror = () => { leafletLoading = null; reject(new Error('The map could not be loaded. Check your connection.')); };
      document.head.appendChild(s);
    });
    return leafletLoading;
  }

  // OpenStreetMap tile usage policy: standard tile server, attribution with link, no bulk/offline use, no prefetching.
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  // ── time + accuracy wording ───────────────────────────────────────────────
  const clock = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const ago = (iso, now = Date.now()) => {
    const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
    if (s < 10) return 'just now'; if (s < 60) return `${s} s ago`; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    return `at ${clock(iso)}`;
  };
  const LIVE_MS = 45000; const STALE_MS = 180000; // must match the server (services/trackingService.js)
  const freshnessOf = (iso, now = Date.now()) => {
    if (!iso) return 'none';
    const age = now - new Date(iso).getTime();
    if (age < LIVE_MS) return 'live';
    return age < STALE_MS ? 'delayed' : 'stale';
  };
  const accuracyInfo = (m) => {
    if (m == null || !Number.isFinite(Number(m))) return { label: 'Unknown', tone: 'wait', text: 'GPS accuracy unknown' };
    const v = Math.round(Number(m));
    if (v <= 25) return { label: 'Good', tone: 'ok', text: `GPS accuracy good (±${v} m)` };
    if (v <= 100) return { label: 'Fair', tone: 'ok', text: `GPS accuracy fair (±${v} m)` };
    if (v <= 500) return { label: 'Poor', tone: 'wait', text: `GPS accuracy poor (±${v} m). Move to an open area for a better fix.` };
    return { label: 'Very poor', tone: 'bad', text: `GPS accuracy very poor (±${v} m). Customers may see a position that is far off.` };
  };

  // ── Geolocation primitives ────────────────────────────────────────────────
  const geoSupported = () => Boolean(navigator.geolocation);
  async function permissionState() {
    if (!geoSupported()) return 'unsupported';
    try { if (navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch (e) { /* not supported */ }
    return 'prompt';
  }
  const geoError = (err) => {
    const code = err && err.code === 1 ? 'denied' : err && err.code === 3 ? 'timeout' : err && err.code === 'unsupported' ? 'unsupported' : 'unavailable';
    const message = {
      denied: 'Location permission was denied. Allow location for LocalHire in your browser settings (the lock icon beside the address bar), then try again.',
      timeout: 'Your device did not return a location in time. Check that GPS / location services are on and try again.',
      unavailable: 'Your device could not determine its location. Check that GPS / location services are switched on.',
      unsupported: 'This browser cannot share location.'
    }[code];
    return { code, message };
  };
  const toFix = (pos) => ({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy, timestamp: pos.timestamp });
  function getPosition({ high = true, maxAge = 0, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!geoSupported()) return reject(geoError({ code: 'unsupported' }));
      navigator.geolocation.getCurrentPosition((p) => resolve(toFix(p)), (e) => reject(geoError(e)), { enableHighAccuracy: high, maximumAge: maxAge, timeout });
    });
  }
  const metersBetween = (a, b) => {
    const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude); const dLon = rad(b.longitude - a.longitude);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  // ── Worker: journey location sharing ──────────────────────────────────────
  // Sends fixes for ONE booking while its journey is under way. Stops itself on arrival / any "not tracking" answer.
  function createSharer({ bookingId, onState }) {
    const KEEPALIVE_MS = 25000;      // stationary phones emit no watch events; refresh anyway so the customer does not see "stale"
    const MIN_SEND_MS = 8000;        // battery / server: at most one update per 8 s ...
    const MIN_MOVE_M = 25;           // ... unless the worker moved at least this far
    const st = { running: false, paused: false, permission: 'prompt', accuracy: null, lastSentAt: null, lastFix: null, lastError: null, mode: 'socket', network: navigator.onLine !== false, sent: 0 };
    let watchId = null; let keepTimer = null; let wakeLock = null; let lastSendMs = 0; let off = [];
    const emit = () => onState && onState({ ...st });

    const send = async (fix) => {
      const payload = { bookingId, latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, timestamp: fix.timestamp };
      const socket = N().getSocket();
      let res;
      if (socket && socket.connected) {
        st.mode = 'socket';
        res = await new Promise((resolve) => socket.timeout(6000).emit('tracking:update', payload, (err, r) => resolve(err ? { ok: false, code: 'TIMEOUT', error: 'No answer from the server.' } : r)));
      }
      if (!res || (!res.ok && res.code === 'TIMEOUT')) {
        st.mode = 'rest';
        const r = await call('POST', `/bookings/${encodeURIComponent(bookingId)}/location`, { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy, timestamp: fix.timestamp });
        res = r.ok ? { ok: true, accepted: r.data.accepted } : { ok: false, code: r.data.code || (r.status === 0 ? 'NETWORK' : 'ERROR'), error: r.data.message || 'Could not send your location.' };
      }
      return res;
    };

    const handleFix = async (fix, force) => {
      if (!st.running || st.paused) return;
      st.lastFix = fix; st.accuracy = fix.accuracy; st.permission = 'granted';
      const now = Date.now();
      const moved = st.lastSentFix ? metersBetween(st.lastSentFix, fix) : Infinity;
      if (!force && now - lastSendMs < MIN_SEND_MS && moved < MIN_MOVE_M) { emit(); return; }
      lastSendMs = now;
      const res = await send(fix);
      if (res.ok) {
        if (res.accepted !== false) { st.lastSentAt = new Date().toISOString(); st.lastSentFix = fix; st.sent += 1; }
        st.lastError = null;
      } else if (res.code === 'NOT_TRACKING' || res.code === 'SESSION_REVOKED' || res.code === 'FORBIDDEN') {
        st.lastError = { code: res.code, message: res.error }; stop(); return;
      } else {
        st.lastError = { code: res.code, message: res.code === 'NETWORK' || res.code === 'TIMEOUT' ? 'No connection. Your last position stays visible to the customer, marked as not live, until you are back online.' : res.error };
      }
      emit();
    };
    const onErr = (e) => {
      const g = geoError(e); st.lastError = { code: g.code, message: g.message };
      if (g.code === 'denied') { st.permission = 'denied'; stop(); return; }
      emit();
    };
    const keepalive = async () => {
      if (!st.running || st.paused || Date.now() - lastSendMs < KEEPALIVE_MS) return;
      try { await handleFix(await getPosition({ high: true, maxAge: 20000, timeout: 15000 }), true); } catch (e) { onErr({ code: e.code === 'denied' ? 1 : e.code === 'timeout' ? 3 : 2 }); }
    };

    async function start() {
      if (st.running) return;
      if (!geoSupported()) { st.lastError = geoError({ code: 'unsupported' }); st.permission = 'unsupported'; emit(); return; }
      st.running = true; st.paused = false; st.lastError = null; emit();
      try { await getPosition({ high: true, maxAge: 0, timeout: 20000 }).then((f) => handleFix(f, true)); } catch (e) { onErr({ code: e.code === 'denied' ? 1 : e.code === 'timeout' ? 3 : 2 }); if (!st.running) return; }
      watchId = navigator.geolocation.watchPosition((p) => handleFix(toFix(p), false), onErr, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
      keepTimer = setInterval(keepalive, KEEPALIVE_MS);
      const onOnline = () => { st.network = true; emit(); keepalive(); };
      const onOffline = () => { st.network = false; emit(); };
      const onVis = () => { if (document.visibilityState === 'visible') { reacquireWakeLock(); keepalive(); } };
      window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); document.addEventListener('visibilitychange', onVis);
      off = [() => window.removeEventListener('online', onOnline), () => window.removeEventListener('offline', onOffline), () => document.removeEventListener('visibilitychange', onVis)];
      // after a socket reconnect, re-join the room so stale/resume events reach this page again
      off.push(N().on('connected', () => { const s = N().getSocket(); if (s && st.running) s.emit('tracking:subscribe', { bookingId }); }));
      reacquireWakeLock();
      emit();
    }
    async function reacquireWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { /* optional */ } }
    function stop() {
      st.running = false;
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null; clearInterval(keepTimer); keepTimer = null;
      off.forEach((f) => { try { f(); } catch (e) { /* ignore */ } }); off = [];
      try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null;
      emit();
    }
    function pause() { st.paused = true; const s = N().getSocket(); if (s) s.emit('tracking:stop', { bookingId }); emit(); }
    function resume() { st.paused = false; lastSendMs = 0; keepalive(); emit(); }
    return { start, stop, pause, resume, state: () => ({ ...st }) };
  }

  // ── Worker: marketplace availability ("Go online") ────────────────────────
  // Heartbeat while online (battery friendly: every 4 minutes + when the page returns / the network comes back).
  // The server treats a position older than 15 minutes as offline.
  function createAvailability({ onState }) {
    const HEARTBEAT_MS = 4 * 60 * 1000;
    const st = { status: 'offline', accuracy: null, lastOkAt: null, message: null, permission: 'prompt', network: navigator.onLine !== false, maxAccuracy: 2000 };
    let timer = null; let off = [];
    const emit = () => onState && onState({ ...st });
    const patch = (body) => call('PATCH', '/users/location', body);

    async function ping(fix) {
      const r = await patch({ sharingEnabled: true, isAvailable: true, latitude: fix.latitude, longitude: fix.longitude, accuracy: Math.min(Math.round(fix.accuracy || 0), 100000), timestamp: fix.timestamp });
      st.accuracy = fix.accuracy;
      if (r.ok) { st.status = 'online'; st.lastOkAt = new Date().toISOString(); st.message = null; return true; }
      if (r.status === 0) { st.message = 'No connection. You stay listed for up to 15 minutes after your last successful update.'; return false; }
      st.message = r.data.message || 'Could not update your location.';
      if (r.data.code === 'LOW_ACCURACY' || r.data.code === 'STALE_FIX') st.status = st.lastOkAt ? 'online' : 'offline';
      return false;
    }
    async function heartbeat(first) {
      if (st.status === 'offline' && !first) return false;
      try {
        const fix = await getPosition({ high: true, maxAge: first ? 0 : 30000, timeout: 20000 });
        st.permission = 'granted';
        const ok = await ping(fix);
        emit(); return ok;
      } catch (e) {
        st.message = e.message || 'Could not read your location.';
        if (e.code === 'denied') { st.permission = 'denied'; await goOffline(e.message); return false; }
        emit(); return false;
      }
    }
    const staleCheck = () => {
      if (st.status === 'online' && st.lastOkAt && Date.now() - new Date(st.lastOkAt).getTime() > 15 * 60 * 1000) {
        st.status = 'stale'; st.message = 'Your location has not been updated for over 15 minutes, so customers can no longer see you online. It resumes when your connection returns.'; emit();
      }
    };
    function arm() {
      clearInterval(timer);
      timer = setInterval(() => { staleCheck(); if (st.status === 'online' || st.status === 'stale') heartbeat(false); }, HEARTBEAT_MS);
      const onVis = () => { if (document.visibilityState === 'visible' && (st.status === 'online' || st.status === 'stale') && (!st.lastOkAt || Date.now() - new Date(st.lastOkAt).getTime() > 2 * 60 * 1000)) heartbeat(false); };
      const onOnline = () => { st.network = true; emit(); if (st.status === 'online' || st.status === 'stale') heartbeat(false); };
      const onOffline = () => { st.network = false; emit(); };
      document.addEventListener('visibilitychange', onVis); window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
      off = [() => document.removeEventListener('visibilitychange', onVis), () => window.removeEventListener('online', onOnline), () => window.removeEventListener('offline', onOffline)];
    }
    async function init() {
      st.permission = await permissionState();
      const r = await call('GET', '/users/location');
      if (r.ok) {
        const l = r.data.location || {}; st.maxAccuracy = r.data.maxAccuracyMeters || 2000; st.accuracy = l.accuracyMeters;
        if (l.sharingEnabled && l.isAvailable) {
          st.lastOkAt = l.lastLocationUpdate;
          if (r.data.isFresh) { st.status = 'online'; } else { st.status = 'stale'; st.message = 'Your location is out of date, so customers cannot see you online. Press "Go online" to refresh it.'; }
          arm();
        }
      }
      emit();
    }
    async function goOnline() {
      st.status = 'starting'; st.message = null; emit();
      const fix = await getPosition({ high: true, maxAge: 0, timeout: 20000 }).catch((e) => { st.status = 'offline'; st.message = e.message; st.permission = e.code === 'denied' ? 'denied' : st.permission; emit(); return null; });
      if (!fix) return false;
      st.permission = 'granted';
      if (fix.accuracy > st.maxAccuracy) { st.status = 'offline'; st.accuracy = fix.accuracy; st.message = `Your GPS accuracy is too low (±${Math.round(fix.accuracy)} m). Move to an open area, turn on high-accuracy location and try again.`; emit(); return false; }
      const ok = await ping(fix);
      if (!ok) { st.status = 'offline'; emit(); return false; }
      arm(); emit(); return true;
    }
    async function goOffline(reason) {
      clearInterval(timer); timer = null; off.forEach((f) => f()); off = [];
      await patch({ sharingEnabled: false, isAvailable: false });
      st.status = 'offline'; st.accuracy = null; st.lastOkAt = null; st.message = reason || null; emit();
    }
    return { init, goOnline, goOffline, state: () => ({ ...st }) };
  }

  // ── Customer: view a worker's journey ─────────────────────────────────────
  // Keeps `view` (the server's participant-checked tracking view) up to date from REST + Socket.IO.
  function createViewer({ bookingId, onView, onEvent }) {
    let view = null; let socket = null; let timer = null; let started = false;
    const emit = () => onView && onView(view);
    async function refresh() {
      const r = await call('GET', `/bookings/${encodeURIComponent(bookingId)}/tracking`);
      if (!r.ok) return { ok: false, status: r.status, message: r.data.message };
      view = { ...r.data.tracking, role: r.data.role }; emit(); return { ok: true, role: r.data.role, tracking: view };
    }
    const patchLocation = (p) => {
      if (!view || p.bookingId !== bookingId) return;
      view = { ...view, sharing: true, location: p.location, lastUpdated: p.lastUpdated, freshness: 'live', paused: false, distanceKm: p.distanceKm == null ? null : p.distanceKm, distanceNote: p.distanceNote || null, journeyStatus: p.journeyStatus || view.journeyStatus };
      emit();
    };
    async function start() {
      if (started) return; started = true;
      const first = await refresh();
      socket = await N().connect();
      if (socket) {
        const join = () => socket.emit('tracking:subscribe', { bookingId }, () => {});
        join(); N().on('connected', () => { join(); refresh(); });
        socket.on('tracking:location', patchLocation);
        socket.on('tracking:state', (s) => { if (s.bookingId === bookingId) { onEvent && onEvent('state', s); } });
        socket.on('tracking:stale', (e) => { if (e.bookingId === bookingId) { onEvent && onEvent('stale', e); if (view) { view = { ...view, paused: true }; emit(); } } });
        socket.on('tracking:resumed', (e) => { if (e.bookingId === bookingId) { onEvent && onEvent('resumed', e); if (view) { view = { ...view, paused: false }; emit(); } } });
        socket.on('tracking:stopped', (e) => { if (e.bookingId === bookingId) { onEvent && onEvent('stopped', e); refresh(); } });
        socket.on('booking:status:changed', (e) => { if (e.bookingId === bookingId) { onEvent && onEvent('status', e); refresh(); } });
      }
      timer = setInterval(emit, 5000); // re-evaluate "x s ago" and freshness every few seconds, even without new data
      return first;
    }
    function stop() { clearInterval(timer); if (socket) { socket.emit('tracking:stop', { bookingId }); } }
    return { start, stop, refresh, view: () => view };
  }

  // Navigation helpers for the worker. These open the user's own maps app / OpenStreetMap; no routing API is called.
  const navLinks = (dest) => (dest ? {
    geo: `geo:${dest.latitude},${dest.longitude}?q=${dest.latitude},${dest.longitude}`,
    osm: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=%3B${dest.latitude}%2C${dest.longitude}`,
    osmPoint: `https://www.openstreetmap.org/?mlat=${dest.latitude}&mlon=${dest.longitude}#map=17/${dest.latitude}/${dest.longitude}`
  } : null);

  window.LocalHireTracking = {
    esc, loadLeaflet, TILE_URL, ATTRIBUTION, clock, ago, freshnessOf, accuracyInfo, permissionState, getPosition, geoError, metersBetween,
    createSharer, createAvailability, createViewer, navLinks, LIVE_MS, STALE_MS
  };
}());
