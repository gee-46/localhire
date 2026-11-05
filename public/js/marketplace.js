/* LocalHire marketplace UI kit (customer-facing pages).
   Shared by customer-home.html, category.html and profile.html. No data is invented here: every worker,
   price, rating, review count and distance shown is whatever the backend returned. */
(function () {
  'use strict';

  const LH = (window.LH = window.LH || {});
  const api = () => window.localHireAPI;
  const app = () => window.localHireApp;

  // ── Helpers ───────────────────────────────────────────────────────────────
  const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  LH.esc = esc;
  const $ = (sel, root) => (root || document).querySelector(sel);
  LH.$ = $;
  const currentUser = () => (app() ? app().getCurrentUser() : null);
  LH.user = currentUser;
  const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  LH.money = money;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  LH.debounce = debounce;

  // ── Icons (original line icons; categories get a tinted tile) ─────────────
  const svg = (inner, extra) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra || ''}>${inner}</svg>`;
  const ICON = {
    pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9z"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    bookings: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    gps: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5"/><path d="M17 5a3.5 3.5 0 0 1 0 7M22 20c0-2.6-1.7-4.3-4-5"/>',
    wrench: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'
  };
  const ui = (name, extra) => svg(ICON[name] || '', extra);
  LH.icon = ui;
  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l4.5 4.5L19 7"/></svg>';

  const CAT_ICONS = {
    painter: '<rect x="3" y="3" width="14" height="6" rx="1.5"/><path d="M17 6h3v5h-8v3"/><rect x="10" y="14" width="4" height="7" rx="1"/>',
    carpenter: '<path d="M3 17L15 5l4 4L7 21H3z"/><path d="M9 11l2 2M12 8l2 2M6 14l2 2"/>',
    plumber: '<path d="M3 8h8a3 3 0 0 1 3 3v2"/><path d="M3 5v6"/><path d="M14 17c-1.6 1.7-2.5 3-2.5 4a2.5 2.5 0 0 0 5 0c0-1-.9-2.3-2.5-4z"/>',
    electrician: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    tutor: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"/><path d="M22 9v6"/>',
    cleaner: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    'ac-repair': '<path d="M12 2v20M4 6l16 12M20 6L4 18"/><path d="M9 3.5l3 2 3-2M9 20.5l3-2 3 2"/>',
    'appliance-repair': '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="4.5"/><path d="M8 6h.01M11 6h.01"/>',
    mechanic: ICON.wrench,
    'pest-control': '<ellipse cx="12" cy="14" rx="4" ry="6"/><path d="M9 7a3 3 0 0 1 6 0M12 8v12M8 11L4 9M16 11l4-2M8 15l-4 1M16 15l4 1M9 19l-3 3M15 19l3 3"/>',
    gardener: '<path d="M12 22V11"/><path d="M12 11C12 6 8 3 3 3c0 5 3 8 9 8z"/><path d="M12 14c0-4 3-7 8-7 0 4-2.5 7-8 7z"/>',
    mason: '<rect x="2" y="4" width="20" height="16" rx="1"/><path d="M2 9.3h20M2 14.7h20M8 4v5.3M16 4v5.3M12 9.3v5.4M7 14.7V20M17 14.7V20"/>',
    tailor: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20M8.1 15.9L20 4"/>',
    'movers-and-packers': '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    'beauty-services': '<rect x="9" y="11" width="6" height="10" rx="1"/><path d="M10 11V7l2-4 2 4v4"/>'
  };
  const tone = (key) => { let h = 0; for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 6; };
  LH.categoryIcon = (cat) => svg(CAT_ICONS[cat.slug] || ICON.grid);
  LH.categoryTile = (cat, { count } = {}) => {
    const sub = typeof count === 'number'
      ? (count > 0 ? `<small class="on">${count} available now</small>` : '<small>None available right now</small>')
      : '<small>&nbsp;</small>';
    return `<a class="lh-cat" href="category.html?category=${encodeURIComponent(cat.slug)}" aria-label="${esc(cat.name)}${typeof count === 'number' ? ', ' + count + ' available now' : ''}">
      <span class="lh-cat-icon lh-tone-${tone(cat.slug)}">${LH.categoryIcon(cat)}</span><strong>${esc(cat.name)}</strong>${sub}</a>`;
  };

  // ── Avatars / pieces of a worker card ─────────────────────────────────────
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  LH.avatar = (worker, size) => {
    const s = size || 56;
    const inner = worker.avatarUrl
      ? `<img src="${esc(worker.avatarUrl)}" alt="" loading="lazy" onerror="this.parentNode.textContent='${esc(initials(worker.name))}'">`
      : esc(initials(worker.name));
    return `<span class="lh-av" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.36)}px">${inner}</span>`;
  };
  LH.verifiedBadge = () => `<span class="lh-verified" title="Identity and documents verified by LocalHire">${CHECK}Verified</span>`;
  LH.hasRating = (w) => Number(w.reviewsCount) > 0 && w.rating !== null && w.rating !== undefined && Number(w.rating) > 0;
  LH.ratingHtml = (w) => LH.hasRating(w)
    ? `<span class="lh-rating">${STAR}${Number(w.rating).toFixed(1)}<small>(${Number(w.reviewsCount)} ${Number(w.reviewsCount) === 1 ? 'review' : 'reviews'})</small></span>`
    : '<span class="lh-rating none">No reviews yet</span>';
  LH.experienceText = (w) => {
    const y = Number(w.experienceYears || 0);
    return y < 1 ? 'Under 1 year experience' : `${y} ${y === 1 ? 'year' : 'years'} experience`;
  };
  LH.priceHtml = (w) => {
    if (w.startingPrice === null || w.startingPrice === undefined) return '<span class="lh-price"><small>Price on request</small></span>';
    const unit = w.priceUnit === 'visit' ? '<small> visit charge</small>' : '<small>/hr</small>';
    const extra = w.priceUnit === 'hour' && Number(w.startingCharge) > 0 ? `<div class="lh-price-sub">+ ${money(w.startingCharge)} visit charge</div>` : '';
    return `<div><span class="lh-price">${money(w.startingPrice)}${unit}</span>${extra}</div>`;
  };
  LH.availabilityPill = (w) => (w.availableNow ? '<span class="lh-pill ok">Available now</span>' : '<span class="lh-pill off">Not available now</span>');
  LH.distanceText = (w) => (typeof w.distanceKm === 'number' ? `About ${w.distanceKm} km away` : null);

  LH.workerCard = (w) => {
    const dist = LH.distanceText(w);
    const skills = (w.skills || []).slice(0, 3).map((s) => `<span class="lh-tag">${esc(s)}</span>`).join('');
    return `<a class="lh-wcard" href="profile.html?id=${encodeURIComponent(w.id)}" aria-label="${esc(w.name)}, ${esc(w.category)}">
      <div class="lh-wtop">${LH.avatar(w, 60)}
        <div style="min-width:0">
          <div class="lh-wname">${esc(w.name)}${w.isVerified ? LH.verifiedBadge() : ''}</div>
          <div class="lh-wsub">${esc(w.category)}</div>
          <div style="margin-top:2px">${LH.ratingHtml(w)}</div>
        </div>
      </div>
      <div class="lh-meta">
        <span>${ui('clock')}${esc(LH.experienceText(w))}</span>
        ${dist ? `<span>${ui('pin')}${esc(dist)}</span>` : (w.serviceArea ? `<span>${ui('pin')}${esc(w.serviceArea)}</span>` : '')}
      </div>
      ${skills ? `<div class="lh-tagrow">${skills}</div>` : ''}
      <div class="lh-wfoot">${LH.priceHtml(w)}${LH.availabilityPill(w)}</div>
    </a>`;
  };

  LH.skeletonCards = (n) => Array.from({ length: n || 4 }, () => `<div class="lh-wcard" aria-hidden="true">
      <div class="lh-wtop"><span class="sk sk-circle" style="width:60px;height:60px"></span><div style="flex:1"><div class="sk sk-line" style="width:60%"></div><div class="sk sk-line" style="width:40%"></div></div></div>
      <div class="sk sk-line" style="width:80%"></div><div class="sk sk-line" style="width:55%"></div>
      <div class="lh-wfoot"><span class="sk sk-line" style="width:70px;height:20px"></span><span class="sk sk-line" style="width:90px;height:20px"></span></div></div>`).join('');
  LH.skeletonTiles = (n) => Array.from({ length: n || 8 }, () => '<div class="lh-cat" aria-hidden="true"><span class="sk" style="width:56px;height:56px;border-radius:16px"></span><div class="sk sk-line" style="width:70%"></div><div class="sk sk-line" style="width:45%"></div></div>').join('');
  LH.stateBox = ({ icon, title, text, action, error }) => `<div class="lh-state ${error ? 'err' : ''}" role="${error ? 'alert' : 'status'}">${ui(icon || 'search')}<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${action || ''}</div>`;

  LH.toast = (message) => {
    let el = $('.lh-toast');
    if (!el) { el = document.createElement('div'); el.className = 'lh-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = message; el.style.display = 'block';
    clearTimeout(LH.toast.t); LH.toast.t = setTimeout(() => { el.style.display = 'none'; }, 3600);
  };

  // ── Access guard ──────────────────────────────────────────────────────────
  // Customer pages: guests may browse (read-only); workers and admins are sent to their own areas.
  LH.guard = ({ requireLogin } = {}) => {
    const u = currentUser();
    if (!u) {
      if (requireLogin) { window.location.replace('auth.html'); return { redirected: true }; }
      return { user: null };
    }
    if (u.role === 'Worker') { window.location.replace('worker-dashboard.html'); return { redirected: true }; }
    if (u.role === 'Admin') { window.location.replace('admin-console.html'); return { redirected: true }; }
    return { user: u };
  };

  // ── Data access (the backend enforces verification, availability and filters) ──
  const J = (path, method, body) => api()._json(path, method, body);
  LH.data = {
    categories: () => api().getCategories(),
    home: (loc) => J('/marketplace/home' + (loc ? `?lat=${loc.lat}&lng=${loc.lng}&radiusKm=${loc.radiusKm || 20}` : '')),
    workers: (params) => {
      const clean = {};
      Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') clean[k] = v; });
      return J('/users/workers?' + new URLSearchParams(clean).toString());
    },
    worker: (id) => J('/users/workers/' + encodeURIComponent(id)),
    reviews: (id, params) => J('/reviews/worker/' + encodeURIComponent(id) + (params ? '?' + new URLSearchParams(params).toString() : '')),
    suggest: (q) => J('/marketplace/suggest?q=' + encodeURIComponent(q)),
    notifications: () => J('/notifications'),
    markRead: (id) => J(`/notifications/${encodeURIComponent(id)}/read`, 'PATCH'),
    bookings: () => J('/bookings/my'),
    addresses: () => J('/users/addresses'),
    createAddress: (a) => J('/users/addresses', 'POST', a),
    createBooking: (b) => J('/bookings', 'POST', b)
  };

  // ── Recently viewed (per customer, stored on this device) ─────────────────
  const recentKey = () => `lh_recent_${(currentUser() || { id: 'guest' }).id}`;
  LH.recent = {
    ids: () => { try { return JSON.parse(localStorage.getItem(recentKey()) || '[]').filter((x) => typeof x === 'string'); } catch (e) { return []; } },
    add: (id) => {
      const next = [id, ...LH.recent.ids().filter((x) => x !== id)].slice(0, 8);
      try { localStorage.setItem(recentKey(), JSON.stringify(next)); } catch (e) { /* storage full or blocked */ }
    }
  };

  // ── Location: browser GPS, OpenStreetMap geocoding, saved preference ──────
  const locKey = () => `lh_location_${(currentUser() || { id: 'guest' }).id}`;
  const listeners = [];
  let cached = null;
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  // Rate-limited + cached (see js/geo.js); falls back to a plain fetch if that file is not loaded
  const geoJson = async (url) => {
    if (window.LocalHireGeo) return window.LocalHireGeo.fetchJson(url);
    const res = await fetch(url); if (!res.ok) throw new Error('Geocoding is unavailable.'); return res.json();
  };

  const parseAddress = (a) => {
    a = a || {};
    const city = a.city || a.town || a.municipality || a.county || a.state_district || a.village || '';
    let locality = a.suburb || a.neighbourhood || a.city_district || a.quarter || a.hamlet || a.village || '';
    if (locality === city) locality = '';
    return { locality, city, label: [locality, city].filter(Boolean).join(', ') };
  };

  LH.location = {
    get() {
      if (cached) return cached;
      try { cached = JSON.parse(localStorage.getItem(locKey()) || 'null'); } catch (e) { cached = null; }
      return cached;
    },
    onChange(fn) { listeners.push(fn); },
    // Remember the chosen place on this device and (for logged-in customers) on their account.
    async set(loc) {
      const value = { lat: Number(loc.lat), lng: Number(loc.lng), locality: loc.locality || '', city: loc.city || '', label: loc.label || '' };
      cached = value;
      try { localStorage.setItem(locKey(), JSON.stringify(value)); } catch (e) { /* ignore */ }
      listeners.forEach((fn) => fn(value));
      if (currentUser() && currentUser().role === 'Customer') {
        try { await J('/users/current-location', 'PATCH', { latitude: value.lat, longitude: value.lng, addressLabel: value.label }); return { saved: true }; }
        catch (e) { return { saved: false, error: e.message }; }
      }
      return { saved: false };
    },
    // On a fresh device, adopt the location saved on the customer's account.
    async restore() {
      if (LH.location.get()) return LH.location.get();
      if (!currentUser() || currentUser().role !== 'Customer') return null;
      try {
        const saved = (await J('/users/current-location')).location;
        if (saved) {
          const [locality, city] = String(saved.addressLabel || '').split(',').map((p) => p.trim());
          cached = { lat: saved.latitude, lng: saved.longitude, locality: city ? locality : '', city: city || locality || '', label: saved.addressLabel || '' };
          try { localStorage.setItem(locKey(), JSON.stringify(cached)); } catch (e) { /* ignore */ }
        }
      } catch (e) { /* no saved location */ }
      return cached;
    },
    // Resolves { lat, lng } or rejects with { code: 'denied' | 'unavailable' | 'timeout' | 'unsupported' }.
    detect() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject({ code: 'unsupported' });
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          (err) => reject({ code: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable' }),
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
        );
      });
    },
    async reverse(lat, lng) {
      const params = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 16, addressdetails: 1, 'accept-language': 'en' });
      let data;
      try { data = await geoJson(`${NOMINATIM}/reverse?${params}`); } catch (e) { throw new Error('Address lookup is unavailable.'); }
      const parsed = parseAddress(data.address);
      return { lat, lng, ...parsed, label: parsed.label || (data.display_name || '').split(',').slice(0, 2).join(',').trim() };
    },
    async search(query) {
      const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: 6, addressdetails: 1, 'accept-language': 'en' });
      let found;
      try { found = await geoJson(`${NOMINATIM}/search?${params}`); } catch (e) { throw new Error('Place search is unavailable.'); }
      return found.map((r) => {
        const parsed = parseAddress(r.address);
        return { lat: Number(r.lat), lng: Number(r.lon), ...parsed, label: parsed.label || String(r.display_name || '').split(',').slice(0, 2).join(',').trim(), full: r.display_name };
      });
    }
  };

  const locationModalHtml = () => `
    <div class="lh-sheet" role="dialog" aria-modal="true" aria-labelledby="lh-loc-title">
      <div class="lh-sheet-head"><h3 id="lh-loc-title">Where do you need the service?</h3>
        <button class="lh-icon-btn" type="button" data-close aria-label="Close">${ui('close')}</button></div>
      <button class="lh-btn lh-btn-primary lh-btn-block" type="button" id="lh-loc-gps">${ui('gps', 'width="20" height="20"')} Use my current location</button>
      <div id="lh-loc-msg" class="lh-help" role="status" aria-live="polite" style="margin-top:10px"></div>
      <div class="lh-field"><label for="lh-loc-q">Or search for your area</label>
        <input class="lh-input" id="lh-loc-q" type="search" placeholder="Locality, street or city" autocomplete="off"></div>
      <div id="lh-loc-results" class="lh-loc-results" style="margin-top:8px"></div>
      <div id="lh-loc-saved" class="lh-loc-results"></div>
    </div>`;

  LH.openLocationModal = ({ reason } = {}) => {
    let ov = $('#lh-loc-overlay');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'lh-loc-overlay'; ov.className = 'lh-overlay'; ov.innerHTML = locationModalHtml();
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) ov.classList.remove('open'); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ov.classList.remove('open'); });

      const msg = $('#lh-loc-msg', ov);
      const results = $('#lh-loc-results', ov);
      const choose = async (loc) => {
        const r = await LH.location.set(loc);
        ov.classList.remove('open');
        LH.toast(r.saved ? `Location set to ${loc.label} and saved to your account` : `Location set to ${loc.label}`);
      };

      $('#lh-loc-gps', ov).addEventListener('click', async () => {
        msg.style.color = ''; msg.textContent = 'Finding your location…';
        try {
          const pos = await LH.location.detect();
          let place;
          try { place = await LH.location.reverse(pos.lat, pos.lng); }
          catch (e) { place = { lat: pos.lat, lng: pos.lng, locality: '', city: '', label: 'Current location' }; }
          msg.textContent = '';
          await choose(place);
        } catch (err) {
          msg.style.color = 'var(--lh-warn)';
          msg.textContent = ({
            denied: 'Location permission was denied, so we can\'t detect where you are. You can allow it in your browser settings, or search for your area below.',
            timeout: 'Finding your location took too long. Please search for your area below.',
            unsupported: 'This browser can\'t share your location. Please search for your area below.',
            unavailable: 'Your location is not available right now. Please search for your area below.'
          })[err.code] || 'Could not detect your location. Please search for your area below.';
          $('#lh-loc-q', ov).focus();
        }
      });

      const runSearch = debounce(async () => {
        const q = $('#lh-loc-q', ov).value.trim();
        if (q.length < 3) { results.innerHTML = ''; return; }
        results.innerHTML = '<div class="lh-help" style="padding:10px">Searching…</div>';
        try {
          const list = await LH.location.search(q);
          results.innerHTML = list.length
            ? list.map((r, i) => `<button type="button" data-i="${i}">${ui('pin')}<span><strong>${esc(r.label)}</strong><br><small style="color:var(--lh-muted)">${esc(r.full || '')}</small></span></button>`).join('')
            : '<div class="lh-help" style="padding:10px">No matching place found. Try a nearby landmark or the city name.</div>';
          results.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => choose(list[Number(b.dataset.i)])));
        } catch (e) {
          results.innerHTML = `<div class="lh-alert err" style="margin-top:6px">${esc(e.message)} Please try again in a moment.</div>`;
        }
      }, 550);
      $('#lh-loc-q', ov).addEventListener('input', runSearch);
    }
    $('#lh-loc-msg', ov).style.color = '';
    $('#lh-loc-msg', ov).textContent = reason || '';
    // Saved addresses that have coordinates are one-tap choices
    const savedBox = $('#lh-loc-saved', ov);
    savedBox.innerHTML = '';
    if (currentUser() && currentUser().role === 'Customer') {
      LH.data.addresses().then((res) => {
        const withCoords = (res.addresses || []).filter((a) => a.latitude !== null && a.longitude !== null);
        if (!withCoords.length) return;
        savedBox.innerHTML = '<h4 style="margin:14px 0 4px;font-size:13px;color:var(--lh-muted)">Your saved addresses</h4>' +
          withCoords.map((a, i) => `<button type="button" data-a="${i}">${ui('home')}<span><strong>${esc(a.label)}</strong><br><small style="color:var(--lh-muted)">${esc([a.street, a.city].filter(Boolean).join(', '))}</small></span></button>`).join('');
        savedBox.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
          const a = withCoords[Number(b.dataset.a)];
          const label = [a.street, a.city].filter(Boolean).join(', ');
          const r = await LH.location.set({ lat: a.latitude, lng: a.longitude, locality: a.street, city: a.city, label });
          ov.classList.remove('open'); LH.toast(r.saved ? `Location set to ${label} and saved` : `Location set to ${label}`);
        }));
      }).catch(() => {});
    }
    ov.classList.add('open');
    setTimeout(() => $('#lh-loc-gps', ov).focus(), 50);
  };

  // ── Header ────────────────────────────────────────────────────────────────
  const timeAgo = (d) => {
    const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000));
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' });
  };

  LH.renderHeader = (target, { active } = {}) => {
    const u = currentUser();
    const loc = LH.location.get();
    const locLabel = loc && loc.label ? loc.label : 'Set your location';
    const role = u && u.role;
    const homeHref = !u ? '../index.html' : role === 'Worker' ? 'worker-dashboard.html' : role === 'Admin' ? 'admin-console.html' : 'customer-home.html';
    const isCustomer = !u || role === 'Customer';
    target.innerHTML = `
      <a class="lh-skip" href="#main">Skip to content</a>
      <header class="lh-header"><div class="lh-container lh-header-inner">
        <a class="lh-logo" href="${homeHref}" aria-label="LocalHire home"><span class="lh-logo-mark">${ui('shield')}</span><span class="lh-logo-text">Local<span>Hire</span></span></a>
        ${isCustomer ? `<button class="lh-loc-pill" type="button" id="lh-loc-btn" aria-haspopup="dialog" aria-label="Service location: ${esc(locLabel)}. Change location">
          ${ui('pin')}<span class="lh-loc-text"><small>Service location</small><strong id="lh-loc-label">${esc(locLabel)}</strong></span></button>` : '<span style="flex:1"></span>'}
        <div class="lh-header-actions">
          ${u ? `
          <a class="lh-icon-btn lh-hide-sm" href="my-jobs.html" aria-label="My bookings" title="My bookings">${ui('bookings')}</a>
          <a class="lh-icon-btn" href="chat.html" id="lh-chat" aria-label="Messages" title="Messages" style="position:relative">${ui('chat')}<span class="cm-dot" id="lh-chat-n" hidden></span></a>
          <div class="lh-menu-wrap" id="lh-bell-mount"></div>
          <div class="lh-menu-wrap"><button class="lh-avatar-btn" type="button" id="lh-profile" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">${LH.avatar({ name: u.name, avatarUrl: u.avatarUrl && !/dicebear\.com/i.test(u.avatarUrl) ? u.avatarUrl : null }, 40)}</button>
            <div class="lh-pop" id="lh-account" role="menu" style="width:260px">
              <div style="padding:10px 10px 6px"><strong>${esc(u.name || 'Your account')}</strong><div class="lh-help">${esc(u.email || '')}</div></div>
              ${role === 'Worker' ? '<a class="lh-pop-item" role="menuitem" href="worker-dashboard.html">Worker hub</a>' : ''}${role === 'Admin' ? '<a class="lh-pop-item" role="menuitem" href="admin-console.html">Admin console</a>' : ''}
              <a class="lh-pop-item" role="menuitem" href="my-jobs.html">My bookings</a>
              <a class="lh-pop-item" role="menuitem" href="chat.html">Messages</a>
              <a class="lh-pop-item" role="menuitem" href="notifications.html">Notifications</a>
              ${isCustomer ? '<a class="lh-pop-item" role="menuitem" href="payments.html">Payments</a><a class="lh-pop-item" role="menuitem" href="category.html">Browse all services</a>' : ''}
              <button class="lh-pop-item" role="menuitem" type="button" id="lh-logout">Log out</button></div></div>` : `
          <a class="lh-btn lh-btn-primary lh-btn-sm" href="auth.html">Sign in</a>`}
        </div></div></header>`;

    if (isCustomer) {
      $('#lh-loc-btn', target).addEventListener('click', () => LH.openLocationModal());
      LH.location.onChange((l) => { const el = $('#lh-loc-label', target); if (el) el.textContent = l.label || 'Set your location'; });
    }

    if (u) {
      const closeAll = () => target.querySelectorAll('.lh-pop').forEach((p) => p.classList.remove('open'));
      document.addEventListener('click', (e) => { if (!e.target.closest('.lh-menu-wrap')) { closeAll(); target.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false')); } });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
      const toggle = (btn, pop, onOpen) => btn.addEventListener('click', () => {
        const open = !pop.classList.contains('open'); closeAll(); pop.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); if (open && onOpen) onOpen();
      });
      toggle($('#lh-profile', target), $('#lh-account', target));
      $('#lh-logout', target).addEventListener('click', () => window.handleLogout());

      // live notification bell + unread message badge (shared module; the header still works without it)
      if (window.LocalHireNotify) {
        window.LocalHireNotify.mountBell($('#lh-bell-mount', target), { className: 'lh-icon-btn cm-bell-btn-lh' });
        const chatDot = $('#lh-chat-n', target);
        const paint = () => { const n = window.LocalHireNotify.state.chatUnread; chatDot.hidden = !n; chatDot.textContent = n > 9 ? '9+' : String(n); $('#lh-chat', target).setAttribute('aria-label', n ? `Messages, ${n} unread` : 'Messages'); };
        window.LocalHireNotify.on('chatUnread', paint); paint();
      }
    }
  };

  LH.renderBottomNav = (target, active) => {
    const u = currentUser();
    const item = (key, href, icon, label) => `<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}>${ui(icon)}<span>${label}</span></a>`;
    target.innerHTML = `<nav class="lh-bottomnav" aria-label="Primary">${item('home', u ? 'customer-home.html' : '../index.html', 'home', 'Home')}${item('browse', 'category.html', 'grid', 'Services')}${item('bookings', u ? 'my-jobs.html' : 'auth.html', 'bookings', 'Bookings')}${item('account', u ? 'my-jobs.html' : 'auth.html', 'user', u ? 'Account' : 'Sign in')}</nav>`;
  };

  // ── Search with suggestions ───────────────────────────────────────────────
  LH.attachSearch = ({ form, input, box }) => {
    let items = []; let idx = -1; let seq = 0;
    const close = () => { box.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); idx = -1; };
    const paint = () => items.forEach((a, i) => a.setAttribute('aria-selected', String(i === idx)));
    const go = (q) => { window.location.href = `category.html?q=${encodeURIComponent(q)}`; };
    const run = debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      const mine = ++seq;
      try {
        const s = await LH.data.suggest(q);
        if (mine !== seq) return;
        const parts = [];
        if (s.categories.length) parts.push('<h5>Categories</h5>' + s.categories.map((c) => `<a role="option" href="category.html?category=${encodeURIComponent(c.slug)}">${esc(c.name)}<small>Browse</small></a>`).join(''));
        if (s.services.length) parts.push('<h5>Services</h5>' + s.services.map((x) => `<a role="option" href="category.html?category=${encodeURIComponent(x.category.slug)}&q=${encodeURIComponent(x.title)}">${esc(x.title)}<small>${esc(x.category.name)}</small></a>`).join(''));
        if (s.workers.length) parts.push('<h5>Professionals</h5>' + s.workers.map((w) => `<a role="option" href="profile.html?id=${encodeURIComponent(w.id)}">${LH.avatar(w, 28)}<span>${esc(w.name)}</span><small>${esc(w.category)}${w.availableNow ? ' · available now' : ''}</small></a>`).join(''));
        parts.push(`<a role="option" href="category.html?q=${encodeURIComponent(q)}">Search all for “${esc(q)}”<small>Enter ↵</small></a>`);
        box.innerHTML = parts.join('');
        box.classList.add('open'); input.setAttribute('aria-expanded', 'true');
        items = Array.from(box.querySelectorAll('a')); idx = -1;
      } catch (e) {
        box.innerHTML = `<a role="option" href="category.html?q=${encodeURIComponent(q)}">Search all for “${esc(q)}”<small>Enter ↵</small></a>`;
        box.classList.add('open'); items = Array.from(box.querySelectorAll('a'));
      }
    }, 250);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); idx = (idx + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); idx = (idx - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && idx >= 0 && items[idx]) { e.preventDefault(); window.location.href = items[idx].getAttribute('href'); }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.lh-search')) close(); });
    form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value.trim(); if (q) go(q); else input.focus(); });
  };

  LH.dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  LH.nowParams = () => { const d = new Date(); return { day: d.getDay(), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }; };
})();
