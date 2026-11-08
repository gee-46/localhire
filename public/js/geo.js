// OpenStreetMap geocoding (Nominatim) used politely, per https://operations.osmfoundation.org/policies/nominatim/ :
//  * at most one request per second, serialized through one queue for the whole page
//  * results cached on the device so the same lookup is never repeated (7 days)
//  * only explicit lookups (a button / a chosen map point); never as-you-type autocomplete
// Browsers send the page's Referer, which identifies LocalHire to the service.
(function () {
  'use strict';
  const MIN_GAP_MS = 1100;
  const TTL_MS = 7 * 24 * 3600 * 1000;
  const MAX_ENTRIES = 60;
  const KEY = 'lh_geo_cache_v1';
  let chain = Promise.resolve();
  let lastAt = 0;
  const inflight = new Map();

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
  const save = (c) => {
    try {
      const keys = Object.keys(c);
      if (keys.length > MAX_ENTRIES) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete c[k]);
      localStorage.setItem(KEY, JSON.stringify(c));
    } catch (e) { /* storage full or blocked: caching is optional */ }
  };
  // Cache key: query string with coordinates rounded to ~11 m so near-identical lookups share an entry.
  const keyFor = (url) => String(url).replace(/(lat|lon)=(-?\d+\.\d+)/g, (m, k, v) => `${k}=${Number(v).toFixed(4)}`);

  function fetchJson(url) {
    const key = keyFor(url);
    const cache = load();
    const hit = cache[key];
    if (hit && Date.now() - hit.t < TTL_MS) return Promise.resolve(hit.v);
    if (inflight.has(key)) return inflight.get(key);
    const p = new Promise((resolve, reject) => {
      chain = chain.then(async () => {
        const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
        if (wait) await new Promise((r) => setTimeout(r, wait));
        lastAt = Date.now();
        try {
          const res = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) throw new Error(`Geocoding service answered ${res.status}`);
          const value = await res.json();
          const c = load(); c[key] = { t: Date.now(), v: value }; save(c);
          resolve(value);
        } catch (e) { reject(e); }
      });
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  window.LocalHireGeo = { fetchJson, MIN_GAP_MS };
}());
