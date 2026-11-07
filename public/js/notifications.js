// LocalHire notifications (browser side): one shared Socket.IO connection, the notification bell, live toasts and
// the Web Push opt-in. Everything shown comes from the server; nothing here invents notifications or counts.
//
// Push honesty: browsers only deliver notifications to a closed tab if the user allowed them AND the vendor's push
// service accepts our subscription. enablePush() reports exactly what happened; it never pretends it worked.
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => { try { return window.sessionStorage.getItem('localHire_token'); } catch (e) { return null; } };
  const base = () => `${window.location.origin}/api`;

  async function call(method, path, body) {
    try {
      const res = await fetch(base() + path, { method, headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null; try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) { return { ok: false, status: 0, data: { message: 'Could not reach LocalHire.' } }; }
  }

  const timeAgo = (d) => {
    const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000));
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' });
  };
  const CATEGORY = { BOOKING: 'Booking', PAYMENT: 'Payment', MESSAGE: 'Message', DISPUTE: 'Dispute', EARNINGS: 'Earnings', SYSTEM: 'Update' };

  // ── state + tiny event bus ────────────────────────────────────────────────
  const state = { unread: 0, chatUnread: 0, status: 'idle', socket: null };
  const listeners = new Map();
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return () => listeners.get(event).delete(fn); };
  const emit = (event, payload) => (listeners.get(event) || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  const setStatus = (s) => { if (state.status !== s) { state.status = s; emit('status', s); } };
  const setUnread = (n) => { state.unread = Math.max(0, Number(n) || 0); emit('unread', state.unread); };
  const setChatUnread = (n) => { state.chatUnread = Math.max(0, Number(n) || 0); emit('chatUnread', state.chatUnread); };

  const urlFor = (n) => {
    if (n.type === 'NEW_MESSAGE' && n.bookingId) return `/pages/chat.html?booking=${encodeURIComponent(n.bookingId)}`;
    if (n.type === 'REVIEW_SUBMITTED') return '/pages/worker-dashboard.html#reviews';
    if (n.bookingId) return `/pages/my-jobs.html?booking=${encodeURIComponent(n.bookingId)}`;
    return '/pages/notifications.html';
  };

  // ── Socket.IO (served by the LocalHire server itself, so there is no third-party script) ──
  let clientLoading = null;
  const loadClient = () => {
    if (window.io) return Promise.resolve(true);
    if (clientLoading) return clientLoading;
    clientLoading = new Promise((resolve) => {
      const s = document.createElement('script'); s.src = '/socket.io/socket.io.js'; s.async = true;
      s.onload = () => resolve(Boolean(window.io)); s.onerror = () => { clientLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return clientLoading;
  };

  async function connect() {
    if (state.socket || !token()) return state.socket;
    if (!(await loadClient())) { setStatus('offline'); return null; }
    setStatus('connecting');
    const socket = window.io(window.location.origin, { auth: (cb) => cb({ token: token() }), transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 8000 });
    state.socket = socket;
    socket.on('connect', () => { setStatus('connected'); refreshCounts(); emit('connected'); });
    socket.on('disconnect', (reason) => {
      // the server ends the connection deliberately when the session was revoked (e.g. logout elsewhere)
      if (reason === 'io server disconnect') { call('GET', '/notifications/unread-count').then((r) => { if (r.status === 401) setStatus('signed-out'); else { setStatus('reconnecting'); socket.connect(); } }); } else setStatus('reconnecting');
    });
    socket.on('connect_error', async (err) => {
      if (/session|token|auth/i.test(err && err.message || '')) { const r = await call('GET', '/notifications/unread-count'); setStatus(r.status === 401 ? 'signed-out' : 'reconnecting'); } else setStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
    });
    socket.on('notification:new', (p) => { setUnread(p.unreadCount); emit('notification', p.notification); toast(p.notification); });
    socket.on('notification:unread', (p) => setUnread(p.unreadCount));
    socket.on('chat:unread', (p) => setChatUnread(p.total));
    window.addEventListener('online', () => { if (!socket.connected) socket.connect(); });
    return socket;
  }

  async function refreshCounts() {
    if (!token()) return;
    const [n, c] = await Promise.all([call('GET', '/notifications/unread-count'), call('GET', '/chat/unread-count')]);
    if (n.ok) setUnread(n.data.unreadCount);
    if (c.ok) setChatUnread(c.data.total);
  }

  // ── toast ────────────────────────────────────────────────────────────────
  function toast(n) {
    if (document.visibilityState !== 'visible') return;
    if (/chat\.html/.test(window.location.pathname) && n.type === 'NEW_MESSAGE') return; // the message itself is on screen
    let host = document.getElementById('cm-toasts');
    if (!host) { host = document.createElement('div'); host.id = 'cm-toasts'; host.className = 'cm-toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite'); document.body.appendChild(host); }
    const el = document.createElement('a');
    el.className = 'cm-toast'; el.href = urlFor(n);
    el.innerHTML = `<strong>${esc(n.title)}</strong><span>${esc(n.message)}</span>`;
    el.addEventListener('click', () => { call('PATCH', `/notifications/${encodeURIComponent(n.id)}/read`); });
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    setTimeout(() => el.remove(), 6000);
  }

  // ── bell ─────────────────────────────────────────────────────────────────
  const BELL_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  // Builds the bell button and its popover inside `target`. Works in both site headers.
  function mountBell(target, { className = 'cm-bell-btn' } = {}) {
    if (!target || !token()) return null;
    target.innerHTML = `<div class="cm-bell-wrap"><button type="button" class="${className}" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">${BELL_SVG}<span class="cm-dot" hidden></span></button>
      <div class="cm-pop" role="menu" hidden></div></div>`;
    const btn = target.querySelector('button'); const dot = target.querySelector('.cm-dot'); const pop = target.querySelector('.cm-pop');
    const paintDot = () => {
      dot.hidden = state.unread === 0; dot.textContent = state.unread > 9 ? '9+' : String(state.unread);
      btn.setAttribute('aria-label', state.unread ? `Notifications, ${state.unread} unread` : 'Notifications');
    };
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const render = async () => {
      pop.innerHTML = '<div class="cm-pop-head"><strong>Notifications</strong></div><div class="cm-pop-empty">Loading…</div>';
      const r = await call('GET', '/notifications?limit=8');
      if (!r.ok) { pop.innerHTML = '<div class="cm-pop-head"><strong>Notifications</strong></div><div class="cm-pop-empty">Notifications could not be loaded.</div>'; return; }
      const list = r.data.notifications || [];
      pop.innerHTML = `<div class="cm-pop-head"><strong>Notifications</strong>${r.data.unreadCount ? '<button type="button" class="cm-link" data-all>Mark all read</button>' : ''}</div>
        ${list.length ? list.map((n) => `<a class="cm-pop-item ${n.isRead ? '' : 'unread'}" role="menuitem" href="${esc(urlFor(n))}" data-id="${esc(n.id)}"><span class="cm-chip cm-${esc(n.category.toLowerCase())}">${esc(CATEGORY[n.category] || 'Update')}</span><strong>${esc(n.title)}</strong><small>${esc(n.message)}</small><small>${esc(timeAgo(n.createdAt))}</small></a>`).join('')
          : '<div class="cm-pop-empty">You\'re all caught up. Updates about your bookings will appear here.</div>'}
        <a class="cm-pop-foot" href="/pages/notifications.html">See all notifications</a>`;
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); const open = pop.hidden; document.querySelectorAll('.cm-pop').forEach((p) => { p.hidden = true; }); pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) render(); });
    pop.addEventListener('click', async (e) => {
      if (e.target.closest('[data-all]')) { e.preventDefault(); await call('POST', '/notifications/read-all'); await refreshCounts(); render(); return; }
      const item = e.target.closest('[data-id]');
      if (item) call('PATCH', `/notifications/${encodeURIComponent(item.dataset.id)}/read`); // navigation continues via the link
    });
    document.addEventListener('click', (e) => { if (!target.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
    on('unread', paintDot); on('notification', () => { if (!pop.hidden) render(); });
    paintDot();
    connect(); refreshCounts();
    return { refresh: refreshCounts };
  }

  // ── Web Push ─────────────────────────────────────────────────────────────
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const urlB64ToU8 = (b64) => { const pad = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };

  // → { supported, configured, permission, subscribed, reason }
  async function pushState() {
    const cfg = await call('GET', '/push/config');
    const configured = Boolean(cfg.ok && cfg.data.supported);
    if (!pushSupported()) {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
      return { supported: false, configured, permission: 'unsupported', subscribed: false, reason: ios ? 'On iPhone and iPad, browser notifications only work after you add LocalHire to your Home Screen (Share → Add to Home Screen) and open it from there.' : 'This browser does not support background notifications. You will still see updates here and in the app while it is open.' };
    }
    let subscribed = false;
    try { const reg = await navigator.serviceWorker.getRegistration('/'); subscribed = Boolean(reg && (await reg.pushManager.getSubscription())); } catch (e) { /* ignore */ }
    return { supported: true, configured, permission: Notification.permission, subscribed, reason: configured ? null : 'Browser notifications are not switched on for this LocalHire server yet.' };
  }

  // MUST be called from a user gesture (a click): this is what shows the browser's permission prompt.
  async function enablePush() {
    const st = await pushState();
    if (!st.supported) return { ok: false, message: st.reason };
    if (!st.configured) return { ok: false, message: st.reason };
    if (Notification.permission === 'denied') return { ok: false, message: 'Notifications are blocked for this site in your browser settings. Allow them there, then try again.' };
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, message: 'You did not allow notifications, so none will be sent to this device.' };
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const cfg = await call('GET', '/push/config');
      let sub = await reg.pushManager.getSubscription();
      // Some browsers/networks never answer the push-service registration. Do not leave the user waiting silently.
      if (!sub) {
        sub = await Promise.race([
          reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(cfg.data.publicKey) }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("your browser's push service did not respond. Check your network and browser settings, then try again")), 20000))
        ]);
      }
      const saved = await call('POST', '/push/subscribe', { subscription: sub.toJSON() });
      if (!saved.ok) { try { await sub.unsubscribe(); } catch (e) { /* ignore */ } return { ok: false, message: saved.data.message || 'The server could not save this device.' }; }
      try { localStorage.removeItem('lh_push_dismissed'); } catch (e) { /* ignore */ }
      return { ok: true, message: 'Browser notifications are on for this device.' };
    } catch (e) {
      return { ok: false, message: `This browser could not set up notifications (${e && e.message ? e.message : 'unknown error'}).` };
    }
  }

  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) { await call('POST', '/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      return { ok: true };
    } catch (e) { return { ok: false, message: 'Could not turn notifications off on this device.' }; }
  }

  // Quiet opt-in banner: shown only where push can work, never auto-prompts, remembers "Not now" for 30 days.
  async function maybeShowPushBanner(container) {
    if (!container || !token()) return;
    let dismissedAt = 0; try { dismissedAt = Number(localStorage.getItem('lh_push_dismissed') || 0); } catch (e) { /* ignore */ }
    if (Date.now() - dismissedAt < 30 * 86400000) return;
    const st = await pushState();
    if (!st.supported || !st.configured || st.permission !== 'default' || st.subscribed) return;
    container.innerHTML = `<div class="cm-banner" role="region" aria-label="Browser notifications"><div><strong>Get alerts even when LocalHire is closed?</strong><span>Turn on browser notifications for booking updates and messages. You can change this any time.</span></div>
      <div class="cm-banner-actions"><button type="button" class="cm-btn ghost" data-later>Not now</button><button type="button" class="cm-btn primary" data-on>Turn on</button></div></div>`;
    container.querySelector('[data-later]').addEventListener('click', () => { try { localStorage.setItem('lh_push_dismissed', String(Date.now())); } catch (e) { /* ignore */ } container.innerHTML = ''; });
    container.querySelector('[data-on]').addEventListener('click', async () => {
      const r = await enablePush();
      container.innerHTML = `<div class="cm-banner ${r.ok ? 'ok' : ''}" role="status"><div><span>${esc(r.message)}</span></div></div>`;
      setTimeout(() => { container.innerHTML = ''; }, 5000);
    });
  }

  // The browser rotated the subscription: store the new one.
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'push-subscription-changed') enablePush(); });

  window.LocalHireNotify = {
    call, esc, timeAgo, urlFor, CATEGORY, state, on, connect, refreshCounts, mountBell, toast,
    getSocket: () => state.socket, pushState, enablePush, disablePush, maybeShowPushBanner
  };
}());
