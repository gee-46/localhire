// LocalHire admin console (browser). Every number shown comes from /api/admin/* (database-backed); nothing is
// computed or invented here beyond formatting. The server enforces the Admin role on every request.
(function () {
  'use strict';
  const P = window.LocalHirePayments; const C = window.AdminCharts;
  const E = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => P.inr(n);
  const num = (n) => Number(n || 0).toLocaleString('en-IN');
  const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
  const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '–');
  const view = document.getElementById('ac-view');
  const title = document.getElementById('ac-title');

  const me = window.localHireApp.getCurrentUser();
  if (!me || me.role !== 'Admin') { window.location.replace('auth.html'); return; }
  document.getElementById('ac-who').textContent = me.name || me.email;
  document.getElementById('ac-foot').textContent = 'Signed in as an administrator. Sensitive actions are logged with your name, the time and a reason.';

  // ── API ──────────────────────────────────────────────────────────────────
  const token = () => { try { return sessionStorage.getItem('localHire_token'); } catch (e) { return null; } };
  async function api(method, path, body, isForm) {
    try {
      const res = await fetch(`${window.location.origin}/api/admin${path}`, { method, headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...(token() ? { Authorization: `Bearer ${token()}` } : {}) }, body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)) });
      let data = null; try { data = await res.json(); } catch (e) { data = null; }
      if (res.status === 401) { window.location.replace('auth.html'); }
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) { return { ok: false, status: 0, data: { message: 'Could not reach the server.' } }; }
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  // ── generic pieces ───────────────────────────────────────────────────────
  const loading = () => { view.innerHTML = '<div class="ac-skel"></div><div class="ac-skel"></div><div class="ac-skel" style="height:160px"></div>'; };
  const errorBox = (r) => { view.innerHTML = `<div class="ac-banner err" role="alert"><b>${r.status === 403 ? 'Administrator access is required.' : 'Could not load this page.'}</b> ${E(r.data.message || 'Please try again.')} <button class="ac-btn sm ghost" type="button" id="ac-retry">Retry</button></div>`; const b = document.getElementById('ac-retry'); if (b) b.addEventListener('click', () => route()); };
  const kpi = (label, value, sub, tone) => `<div class="ac-kpi ${tone || ''}"><span>${E(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const badge = (text, tone) => `<span class="ac-badge ${tone || ''}">${E(text)}</span>`;
  const STATUS_TONE = { COMPLETED: 'ok', CANCELLED: 'bad', DISPUTED: 'bad', REQUESTED: 'warn', CONFIRMED: 'info', DISPATCHED: 'info', IN_PROGRESS: 'info', AWAITING_CUSTOMER_CONFIRMATION: 'info' };
  const statusBadge = (s) => badge(String(s).replace(/_/g, ' ').toLowerCase(), STATUS_TONE[s]);
  const PAY_TONE = { CAPTURED: 'ok', PARTIALLY_REFUNDED: 'info', REFUNDED: 'info', FAILED: 'bad', CREATED: 'warn', AUTHORIZED: 'info' };
  const SETTLE_TONE = { PAID: 'ok', ELIGIBLE: 'info', PAYOUT_PROCESSING: 'info', FAILED: 'bad', BLOCKED: 'warn', PENDING_COMPLETION: 'warn', CANCELLED: '', REVERSED: 'bad' };
  const empty = (h, p) => `<div class="ac-empty"><h3>${E(h)}</h3><p>${E(p || '')}</p></div>`;

  const table = (cols, rows, { onRow, emptyMsg = ['Nothing to show', 'No records match these filters.'] } = {}) => {
    if (!rows.length) return `<div class="ac-table-wrap">${empty(...emptyMsg)}</div>`;
    return `<div class="ac-table-wrap"><table class="ac-table"><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${E(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr ${onRow ? `class="click" data-i="${i}" tabindex="0"` : ''}>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  const pager = (d) => `<div class="ac-pager"><span>${num(d.total)} result${d.total === 1 ? '' : 's'} · page ${d.page} of ${d.pages}</span><span><button class="ac-btn sm ghost" type="button" data-pg="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>Previous</button> <button class="ac-btn sm ghost" type="button" data-pg="${d.page + 1}" ${d.page >= d.pages ? 'disabled' : ''}>Next</button></span></div>`;
  const wireRows = (container, rows, fn) => {
    container.querySelectorAll('tr.click').forEach((tr) => { const go = () => fn(rows[Number(tr.dataset.i)]); tr.addEventListener('click', go); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }); });
  };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const shiftDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const rangeBar = (state, { granularity } = {}) => `<form class="ac-bar" id="ac-range" aria-label="Date range">
      <label class="ac-field">From<input class="ac-input" type="date" name="from" value="${E(state.from || '')}"></label>
      <label class="ac-field">To<input class="ac-input" type="date" name="to" value="${E(state.to || '')}"></label>
      ${granularity ? `<label class="ac-field">Group by<select class="ac-select" name="granularity"><option value="day" ${state.granularity !== 'month' ? 'selected' : ''}>Day</option><option value="month" ${state.granularity === 'month' ? 'selected' : ''}>Month</option></select></label>` : ''}
      <button class="ac-btn" type="submit">Apply</button>
      <button class="ac-btn ghost" type="button" data-preset="7">Last 7 days</button><button class="ac-btn ghost" type="button" data-preset="30">Last 30 days</button><button class="ac-btn ghost" type="button" data-preset="all">All time</button></form>`;
  const wireRange = (state, reload) => {
    const f = document.getElementById('ac-range'); if (!f) return;
    f.addEventListener('submit', (e) => { e.preventDefault(); state.from = f.from.value; state.to = f.to.value; if (f.granularity) state.granularity = f.granularity.value; reload(); });
    f.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { const p = b.dataset.preset; state.from = p === 'all' ? '' : shiftDays(-(Number(p) - 1)); state.to = p === 'all' ? '' : shiftDays(0); reload(); }));
  };
  const detailDialog = (html) => { const d = P.dialog(`<button class="pay-x" type="button" aria-label="Close" data-x>&times;</button>${html}`); d.el.style.maxWidth = '760px'; d.el.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) d.close('x'); }); return d; };
  // Toasts stack in one container so several in a row never overlap.
  const toast = (text, tone) => {
    let box = document.getElementById('ac-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'ac-toasts'; box.className = 'ac-toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = `ac-banner ${tone || 'ok'}`; t.setAttribute('role', tone === 'err' ? 'alert' : 'status'); t.textContent = text;
    box.appendChild(t); setTimeout(() => t.remove(), 4500);
  };
  // A category icon whose file cannot be loaded falls back to the category's initial.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.classList.contains('ac-icon')) return;
    const span = document.createElement('span'); span.className = 'ac-icon'; span.setAttribute('aria-hidden', 'true'); span.textContent = (img.dataset.initial || '?').slice(0, 1);
    img.replaceWith(span);
  }, true);
  const reasonPrompt = (titleText, message, confirmText, danger) => P.ask({ title: titleText, message, confirmText, danger, input: { label: 'Reason (recorded in the audit log)', multiline: true, maxLength: 500, validate: (v) => (v.trim().length < 5 ? 'Please give a reason of at least 5 characters.' : null) } });

  // ── Overview ─────────────────────────────────────────────────────────────
  const st = { reviews: { page: 1, state: '' }, overview: { from: '', to: '' }, workers: { page: 1 }, customers: { page: 1 }, bookings: { page: 1, status: '' }, finance: { from: '', to: '', sPage: 1, sStatus: '' }, analytics: { from: shiftDays(-29), to: shiftDays(0), granularity: 'day' }, audit: { page: 1 }, categories: {} };

  async function overview() {
    loading();
    const s = st.overview; const r = await api('GET', `/dashboard?${qs({ from: s.from, to: s.to })}`);
    if (!r.ok) return errorBox(r);
    const d = r.data; const u = d.users; const b = d.bookings; const m = d.money;
    view.innerHTML = `${rangeBar(s)}
      <p class="ac-fine" style="margin-bottom:10px">${s.from || s.to ? `Bookings and money are for ${E(s.from || 'the beginning')} to ${E(s.to || 'today')}. People counts are always current.` : 'Showing all time. People counts are always current.'}</p>
      <h2 class="ac-h2">People</h2>
      <div class="ac-grid">${kpi('Customers', num(u.customers))}${kpi('Workers', num(u.workers), `${num(u.suspendedAccounts)} suspended account(s)`)}${kpi('Verified workers', num(u.verifiedWorkers), 'Identity documents approved', 'ok')}
        ${kpi('Pending verifications', num(u.pendingVerifications), '<a href="admin.html#worker-verification-card">Review documents →</a>', u.pendingVerifications ? 'warn' : '')}${kpi('Online workers', num(u.onlineWorkers), 'Verified, available, position under 15 min old')}</div>
      <h2 class="ac-h2">Bookings</h2>
      <div class="ac-grid">${kpi('Total bookings', num(b.total))}${kpi('Pending', num(b.pending), 'Waiting for the professional')}${kpi('Active', num(b.active), `${num(b.accepted)} accepted · ${num(b.journeyStarted)} on the way · ${num(b.arrived)} arrived · ${num(b.inService)} in service · ${num(b.completionRequested)} awaiting confirmation`)}
        ${kpi('Completed', num(b.completed), 'Confirmed by the customer', 'ok')}${kpi('Cancelled', num(b.cancelled))}${kpi('Disputed', num(b.disputed), d.openSupportTickets ? `${num(d.openSupportTickets)} open support ticket(s)` : '', b.disputed ? 'bad' : '')}</div>
      <h2 class="ac-h2">Money <a class="ac-fine" href="#/finance" style="margin-left:8px">Full financial dashboard →</a></h2>
      <div class="ac-banner ${m.payoutMode === 'ROUTE' ? 'ok' : 'warn'}">${E(m.payoutNote)}</div>
      <div class="ac-grid">${kpi('Gross service value', inr(m.grossServiceValue), 'The professionals\' service prices on payments captured in this period')}
        ${kpi('LocalHire commission earned', inr(m.commissionEarned), `${E(m.commissionRatePercent)}% on jobs the customer confirmed. ${inr(m.commissionPending)} more is pending confirmation`, 'ok')}
        ${kpi('Refunds', inr(m.refunds), 'Processed by Razorpay')}${kpi('Taxes held', inr(m.taxesHeld), 'Collected for the tax authority; not LocalHire revenue')}
        ${kpi('Outstanding worker settlements', inr(m.outstandingWorkerSettlements), `${inr(m.owedNotYetTransferred)} is confirmed and owed but NOT yet transferred`, m.outstandingWorkerSettlements ? 'warn' : '')}
        ${kpi('Actual worker payouts', inr(m.actualWorkerPayouts), 'Only what the payment provider reported settled', 'ok')}${kpi('Failed payouts', inr(m.failedPayouts), '', m.failedPayouts ? 'bad' : '')}</div>
      <h2 class="ac-h2">Bookings, last 30 days</h2><div class="ac-card"><div class="ac-chart" id="ov-chart"><div class="ac-skel"></div></div></div>`;
    wireRange(s, overview);
    const a = await api('GET', `/analytics?${qs({ from: shiftDays(-29), to: shiftDays(0) })}`);
    const box = document.getElementById('ov-chart'); if (!box) return;
    if (!a.ok) { box.innerHTML = `<div class="ac-empty-chart">${E(a.data.message || 'Chart unavailable')}</div>`; return; }
    C.timeSeries(box, { title: 'Bookings per day', labels: a.data.bookings.map((x) => x.bucket), series: [{ name: 'Created', values: a.data.bookings.map((x) => x.total), type: 'bar', color: '#5b3df5' }, { name: 'Completed', values: a.data.bookings.map((x) => x.completed), type: 'line', color: '#12805c' }] });
  }

  // ── Workers ──────────────────────────────────────────────────────────────
  let categoriesCache = null;
  const categoryOptions = async () => { if (!categoriesCache) { const r = await api('GET', '/categories'); categoriesCache = r.ok ? r.data.categories : []; } return categoriesCache; };

  async function workers() {
    const s = st.workers; loading();
    const cats = await categoryOptions();
    const r = await api('GET', `/workers?${qs({ q: s.q, categoryId: s.categoryId, city: s.city, locality: s.locality, verification: s.verification, availability: s.availability, status: s.status, page: s.page, limit: 12 })}`);
    if (!r.ok) return errorBox(r);
    const d = r.data;
    view.innerHTML = `<form class="ac-bar" id="wf" role="search" aria-label="Filter workers">
        <label class="ac-field">Search<input class="ac-input" name="q" value="${E(s.q || '')}" placeholder="Name or e-mail"></label>
        <label class="ac-field">Profession<select class="ac-select" name="categoryId"><option value="">All</option>${cats.map((c) => `<option value="${E(c.id)}" ${s.categoryId === c.id ? 'selected' : ''}>${E(c.name)}</option>`).join('')}</select></label>
        <label class="ac-field">City<input class="ac-input" name="city" value="${E(s.city || '')}"></label><label class="ac-field">Locality<input class="ac-input" name="locality" value="${E(s.locality || '')}"></label>
        <label class="ac-field">Verification<select class="ac-select" name="verification"><option value="">Any</option>${['UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED'].map((v) => `<option value="${v}" ${s.verification === v ? 'selected' : ''}>${v.replace('_', ' ').toLowerCase()}</option>`).join('')}</select></label>
        <label class="ac-field">Availability<select class="ac-select" name="availability"><option value="">Any</option><option value="online" ${s.availability === 'online' ? 'selected' : ''}>Online now</option><option value="offline" ${s.availability === 'offline' ? 'selected' : ''}>Offline</option></select></label>
        <label class="ac-field">Account<select class="ac-select" name="status"><option value="">Any</option><option value="active" ${s.status === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${s.status === 'suspended' ? 'selected' : ''}>Suspended</option></select></label>
        <button class="ac-btn" type="submit">Search</button><button class="ac-btn ghost" type="button" id="wf-clear">Clear</button></form>
      ${table([
        { h: 'Worker', f: (w) => `<b>${E(w.name)}</b><small>${E(w.email)}</small>` }, { h: 'Profession', f: (w) => E(w.profession || '–') }, { h: 'Area', f: (w) => E([w.locality, w.city].filter(Boolean).join(', ') || '–') },
        { h: 'Verification', f: (w) => badge(w.verificationStatus.replace('_', ' ').toLowerCase(), w.verificationStatus === 'VERIFIED' ? 'ok' : w.verificationStatus === 'REJECTED' ? 'bad' : 'warn') },
        { h: 'Status', f: (w) => `${w.suspended ? badge('suspended', 'bad') : badge(w.online ? 'online' : 'offline', w.online ? 'ok' : '')}` },
        { h: 'Jobs', num: true, f: (w) => num(w.completedJobs) }, { h: 'Rating', num: true, f: (w) => (w.rating !== null ? `${w.rating.toFixed(1)} ★ (${w.reviewsCount})` : 'No reviews') }
      ], d.workers, { onRow: true, emptyMsg: ['No workers found', 'Try different filters.'] })}${pager(d)}`;
    const form = document.getElementById('wf');
    form.addEventListener('submit', (e) => { e.preventDefault(); Object.assign(s, { page: 1 }); for (const k of ['q', 'categoryId', 'city', 'locality', 'verification', 'availability', 'status']) s[k] = form[k].value.trim(); workers(); });
    document.getElementById('wf-clear').addEventListener('click', () => { st.workers = { page: 1 }; workers(); });
    view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { s.page = Number(b.dataset.pg); workers(); }));
    wireRows(view, d.workers, (w) => workerDetail(w.id));
  }

  async function workerDetail(id) {
    const dlg = detailDialog('<div class="pay-spin" role="status" aria-label="Loading"></div>');
    const r = await api('GET', `/workers/${encodeURIComponent(id)}`);
    if (!r.ok) { dlg.set(`<button class="pay-x" type="button" data-x aria-label="Close">&times;</button><h3 id="pay-title">Could not load worker</h3><div class="pay-note err">${E(r.data.message || '')}</div>`); return; }
    const w = r.data.worker; const p = w.profile; const v = w.verification;
    dlg.set(`<button class="pay-x" type="button" aria-label="Close" data-x>&times;</button><h3 id="pay-title">${E(w.name)}</h3>
      <p class="pay-sub">${w.suspended ? badge('suspended', 'bad') : badge('active', 'ok')} ${badge(v.status.replace('_', ' ').toLowerCase(), v.status === 'VERIFIED' ? 'ok' : 'warn')} ${p && p.online ? badge('online', 'ok') : ''}</p>
      ${w.suspended ? `<div class="pay-note err"><b>Suspended</b> ${E(day(w.suspendedAt))}: ${E(w.suspensionReason || 'no reason recorded')}</div>` : ''}
      <dl class="ac-dl"><dt>E-mail</dt><dd>${E(w.email)}</dd><dt>Phone</dt><dd>${E(w.phone || '–')}</dd><dt>Profession</dt><dd>${E(p ? p.profession : '–')}</dd><dt>Area</dt><dd>${E(p ? [p.locality, p.city].filter(Boolean).join(', ') || '–' : '–')}</dd>
        <dt>Experience</dt><dd>${p ? E(p.experienceYears) + ' years' : '–'}</dd><dt>Joined</dt><dd>${E(day(w.joinedAt))}</dd></dl>
      <h4>Work</h4><dl class="ac-dl"><dt>Completed jobs</dt><dd>${num(w.stats.completedJobs)} of ${num(w.stats.totalBookings)} bookings</dd><dt>Earnings owed (not yet transferred)</dt><dd>${inr(w.earnings.owedNotYetTransferred)}</dd><dt>Pending / on hold</dt><dd>${inr(w.earnings.pending)}</dd><dt>Paid out</dt><dd>${inr(w.earnings.paidOut)}</dd></dl>
      <h4>Identity verification</h4>
      <p class="pay-sub">Documents are reviewed in the verification queue. Only the type and review status are shown here. ${v.decisionReason ? 'Last decision: ' + E(v.decisionReason) : ''} <a href="admin.html#worker-verification-card">Open verification queue →</a></p>
      <ul class="ac-list">${v.documents.length ? v.documents.map((x) => `<li>${E(x.type.replace(/_/g, ' ').toLowerCase())} ${badge(x.status.toLowerCase(), x.status === 'VERIFIED' ? 'ok' : x.status === 'REJECTED' ? 'bad' : 'warn')}${x.rejectionReason ? ` <small>${E(x.rejectionReason)}</small>` : ''}</li>`).join('') : '<li>No documents uploaded.</li>'}</ul>
      <h4>Verification history</h4><ul class="ac-list">${v.history.length ? v.history.map((h) => `<li><b>${E(h.action.replace(/_/g, ' ').toLowerCase())}</b> by ${E(h.actorRole.toLowerCase())} · ${E(when(h.at))}${h.reason ? `<br><small>${E(h.reason)}</small>` : ''}</li>`).join('') : '<li>No history yet.</li>'}</ul>
      <h4>Reviews (${p ? num(p.reviewsCount) : 0})</h4><ul class="ac-list">${w.reviews.length ? w.reviews.map((x) => `<li>${'★'.repeat(x.rating)}${'☆'.repeat(5 - x.rating)} <b>${E(x.customer)}</b> · ${E(x.bookingNumber)} · ${E(day(x.at))}${x.status === 'HIDDEN' ? ' ' + badge('hidden', 'bad') : ''}<br>${E(x.comment)}</li>`).join('') : '<li>No reviews yet.</li>'}</ul>
      <h4>Recent bookings</h4><ul class="ac-list">${w.recentBookings.length ? w.recentBookings.map((b) => `<li>${E(b.bookingNumber)} · ${E(b.customer)} · ${inr(b.price)} ${statusBadge(b.status)}</li>`).join('') : '<li>None.</li>'}</ul>
      ${w.complaints.length ? `<h4>Complaints</h4><ul class="ac-list">${w.complaints.map((t) => `<li>${E(t.ticketNumber)} · ${E(t.subject)} ${badge(t.status.replace('_', ' ').toLowerCase(), 'warn')}</li>`).join('')}</ul>` : ''}
      <div class="pay-actions">${w.suspended ? '<button class="pay-btn primary" type="button" data-act="reactivate">Reactivate account</button>' : '<button class="pay-btn danger" type="button" data-act="suspend">Suspend account</button>'}<button class="pay-btn ghost" type="button" data-x>Close</button></div>
      ${w.suspended ? '<p class="ac-fine" style="margin-top:8px">Reactivating does not verify the worker: identity approval still goes through the document review.</p>' : ''}`);
    dlg.el.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const suspend = a.dataset.act === 'suspend';
      const ans = await reasonPrompt(suspend ? `Suspend ${w.name}?` : `Reactivate ${w.name}?`, suspend ? 'They are signed out and removed from customer search immediately. Existing bookings are not changed.' : 'They can sign in again. Their verification status is not changed.', suspend ? 'Suspend' : 'Reactivate', suspend);
      if (!ans.confirmed) return;
      const res = await api('POST', `/workers/${encodeURIComponent(id)}/${a.dataset.act}`, { reason: ans.value.trim() });
      if (res.ok) { toast(res.data.note ? `${res.data.message} ${res.data.note}` : res.data.message); dlg.close('done'); workers(); } else toast(res.data.message || 'Failed', 'err');
    });
  }

  // ── Customers ────────────────────────────────────────────────────────────
  async function customers() {
    const s = st.customers; loading();
    const r = await api('GET', `/customers?${qs({ q: s.q, status: s.status, page: s.page, limit: 12 })}`);
    if (!r.ok) return errorBox(r);
    const d = r.data;
    view.innerHTML = `<form class="ac-bar" id="cf" role="search"><label class="ac-field">Search<input class="ac-input" name="q" value="${E(s.q || '')}" placeholder="Name or e-mail"></label>
      <label class="ac-field">Account<select class="ac-select" name="status"><option value="">Any</option><option value="active" ${s.status === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${s.status === 'suspended' ? 'selected' : ''}>Suspended</option></select></label>
      <button class="ac-btn" type="submit">Search</button><button class="ac-btn ghost" type="button" id="cf-clear">Clear</button></form>
      <p class="ac-fine" style="margin-bottom:8px">Contact details are masked in this list. Opening a customer shows them and is recorded in the audit log.</p>
      ${table([{ h: 'Customer', f: (c) => `<b>${E(c.name)}</b><small>${E(c.email)}</small>` }, { h: 'Phone', f: (c) => E(c.phone || '–') }, { h: 'Bookings', num: true, f: (c) => num(c.bookings) }, { h: 'Status', f: (c) => (c.suspended ? badge('suspended', 'bad') : badge('active', 'ok')) }, { h: 'Joined', f: (c) => E(day(c.joinedAt)) }], d.customers, { onRow: true, emptyMsg: ['No customers found', 'Try a different search.'] })}${pager(d)}`;
    const f = document.getElementById('cf');
    f.addEventListener('submit', (e) => { e.preventDefault(); s.q = f.q.value.trim(); s.status = f.status.value; s.page = 1; customers(); });
    document.getElementById('cf-clear').addEventListener('click', () => { st.customers = { page: 1 }; customers(); });
    view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { s.page = Number(b.dataset.pg); customers(); }));
    wireRows(view, d.customers, (c) => customerDetail(c.id));
  }

  async function customerDetail(id) {
    const dlg = detailDialog('<div class="pay-spin" role="status" aria-label="Loading"></div>');
    const r = await api('GET', `/customers/${encodeURIComponent(id)}`);
    if (!r.ok) { dlg.set(`<button class="pay-x" type="button" data-x aria-label="Close">&times;</button><h3 id="pay-title">Could not load customer</h3><div class="pay-note err">${E(r.data.message || '')}</div>`); return; }
    const c = r.data.customer;
    dlg.set(`<button class="pay-x" type="button" aria-label="Close" data-x>&times;</button><h3 id="pay-title">${E(c.name)}</h3>
      <p class="pay-sub">${c.suspended ? badge('suspended', 'bad') : badge('active', 'ok')}</p>
      ${c.suspended ? `<div class="pay-note err"><b>Suspended</b> ${E(day(c.suspendedAt))}: ${E(c.suspensionReason || '')}</div>` : ''}
      <dl class="ac-dl"><dt>E-mail</dt><dd>${E(c.email)}</dd><dt>Phone</dt><dd>${E(c.phone || '–')}</dd><dt>Joined</dt><dd>${E(day(c.joinedAt))}</dd><dt>Bookings</dt><dd>${num(c.stats.totalBookings)}</dd><dt>Total paid</dt><dd>${inr(c.stats.totalPaid)}</dd><dt>Total refunded</dt><dd>${inr(c.stats.totalRefunded)}</dd></dl>
      <p class="ac-fine">Viewing this profile was recorded in the audit log. Street addresses and payment-gateway identifiers are never shown.</p>
      <h4>Booking history</h4><ul class="ac-list">${c.bookings.length ? c.bookings.map((b) => `<li>${E(b.bookingNumber)} · ${E(b.worker)} · ${E(b.city || '')} · ${inr(b.price)} ${statusBadge(b.status)} ${b.paymentState ? badge(b.paymentState.replace('_', ' ').toLowerCase(), PAY_TONE[b.paymentState]) : ''}</li>`).join('') : '<li>No bookings.</li>'}</ul>
      <h4>Payments</h4><ul class="ac-list">${c.payments.length ? c.payments.map((p) => `<li>${E(p.paymentNumber)} · ${E(p.bookingNumber)} · ${inr(p.total)}${p.refunded ? ` (refunded ${inr(p.refunded)})` : ''} ${badge(p.state.replace('_', ' ').toLowerCase(), PAY_TONE[p.state])}${p.disputed ? ' ' + badge('dispute', 'bad') : ''} <small>${E(when(p.at))}</small></li>`).join('') : '<li>No payments.</li>'}</ul>
      <h4>Complaints</h4><ul class="ac-list">${c.complaints.length ? c.complaints.map((t) => `<li>${E(t.ticketNumber)} · ${E(t.subject)} ${badge(t.status.replace('_', ' ').toLowerCase(), 'warn')} <small>${E(day(t.createdAt))}${t.bookingNumber ? ' · ' + E(t.bookingNumber) : ''}</small></li>`).join('') : '<li>None.</li>'}</ul>
      <div class="pay-actions">${c.suspended ? '<button class="pay-btn primary" type="button" data-act="reactivate">Reactivate account</button>' : '<button class="pay-btn danger" type="button" data-act="suspend">Suspend account</button>'}<button class="pay-btn ghost" type="button" data-x>Close</button></div>`);
    dlg.el.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const suspend = a.dataset.act === 'suspend';
      const ans = await reasonPrompt(suspend ? `Suspend ${c.name}?` : `Reactivate ${c.name}?`, suspend ? 'They are signed out and cannot book or pay. Existing bookings and payments are not changed.' : 'They can sign in again.', suspend ? 'Suspend' : 'Reactivate', suspend);
      if (!ans.confirmed) return;
      const res = await api('POST', `/customers/${encodeURIComponent(id)}/${a.dataset.act}`, { reason: ans.value.trim() });
      if (res.ok) { toast(res.data.note ? `${res.data.message} ${res.data.note}` : res.data.message); dlg.close('done'); customers(); } else toast(res.data.message || 'Failed', 'err');
    });
  }

  // ── Bookings ─────────────────────────────────────────────────────────────
  const BK_FILTERS = [['', 'All'], ['requested', 'Requested'], ['accepted', 'Accepted'], ['active', 'Active'], ['journey_started', 'Journey started'], ['arrived', 'Arrived'], ['in_service', 'In service'], ['completion_requested', 'Completion requested'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['disputed', 'Disputed']];
  async function bookings() {
    const s = st.bookings; loading();
    const r = await api('GET', `/bookings?${qs({ status: s.status, q: s.q, from: s.from, to: s.to, page: s.page, limit: 12 })}`);
    if (!r.ok) return errorBox(r);
    const d = r.data;
    view.innerHTML = `<div class="ac-chips" role="group" aria-label="Booking status">${BK_FILTERS.map(([v, l]) => `<button class="ac-chip" type="button" data-f="${v}" aria-pressed="${s.status === v}">${l}</button>`).join('')}</div>
      <form class="ac-bar" id="bf"><label class="ac-field">Search<input class="ac-input" name="q" value="${E(s.q || '')}" placeholder="Booking no., customer or worker"></label>
        <label class="ac-field">Created from<input class="ac-input" type="date" name="from" value="${E(s.from || '')}"></label><label class="ac-field">to<input class="ac-input" type="date" name="to" value="${E(s.to || '')}"></label>
        <button class="ac-btn" type="submit">Apply</button><button class="ac-btn ghost" type="button" id="bf-clear">Clear</button></form>
      ${table([{ h: 'Booking', f: (b) => `<b>${E(b.bookingNumber)}</b><small>${E(day(b.createdAt))}</small>` }, { h: 'Customer → Professional', f: (b) => `${E(b.customer)} → ${E(b.worker)}<small>${E(b.service)}</small>` },
        { h: 'Status', f: (b) => `${statusBadge(b.status)}${b.journeyStatus && ['JOURNEY_STARTED', 'WORKER_ARRIVED'].includes(b.journeyStatus) ? `<small>${E(b.journeyStatus.replace('_', ' ').toLowerCase())}</small>` : ''}` },
        { h: 'Price', num: true, f: (b) => inr(b.price) }, { h: 'Payment', f: (b) => (b.payment ? `${badge(b.payment.state.replace('_', ' ').toLowerCase(), PAY_TONE[b.payment.state])}${b.payment.disputed ? ' ' + badge('dispute', 'bad') : ''}<small>${b.payment.settlement ? 'worker: ' + E(b.payment.settlement.replace(/_/g, ' ').toLowerCase()) : ''}</small>` : '<span class="ac-fine">not paid</span>') }], d.bookings, { onRow: true, emptyMsg: ['No bookings match', 'Change the status or date filters.'] })}${pager(d)}
      <p class="ac-fine">This list is read-only. Booking and payment states change only through the normal booking flow, refunds and dispute resolution (<a href="admin.html">Payments panel</a>).</p>`;
    view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { s.status = b.dataset.f; s.page = 1; bookings(); }));
    const f = document.getElementById('bf');
    f.addEventListener('submit', (e) => { e.preventDefault(); s.q = f.q.value.trim(); s.from = f.from.value; s.to = f.to.value; s.page = 1; bookings(); });
    document.getElementById('bf-clear').addEventListener('click', () => { st.bookings = { page: 1, status: s.status }; bookings(); });
    view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { s.page = Number(b.dataset.pg); bookings(); }));
    wireRows(view, d.bookings, (b) => bookingDetail(b.id));
  }

  async function bookingDetail(id) {
    const dlg = detailDialog('<div class="pay-spin" role="status" aria-label="Loading"></div>');
    const r = await api('GET', `/bookings/${encodeURIComponent(id)}`);
    if (!r.ok) { dlg.set(`<button class="pay-x" type="button" data-x aria-label="Close">&times;</button><h3 id="pay-title">Could not load booking</h3><div class="pay-note err">${E(r.data.message || '')}</div>`); return; }
    const b = r.data.booking; const p = b.payment;
    dlg.set(`<button class="pay-x" type="button" aria-label="Close" data-x>&times;</button><h3 id="pay-title">Booking ${E(b.bookingNumber)}</h3>
      <p class="pay-sub">${statusBadge(b.status)} ${b.journeyStatus ? badge(b.journeyStatus.replace(/_/g, ' ').toLowerCase()) : ''}</p>
      <dl class="ac-dl"><dt>Customer</dt><dd>${E(b.customer.name)}</dd><dt>Professional</dt><dd>${E(b.worker.name)}</dd><dt>Service</dt><dd>${E(b.service || b.problemDescription || '–')}</dd><dt>Area</dt><dd>${E(b.area || '–')}</dd><dt>Scheduled</dt><dd>${E(when(b.scheduledAt))}${b.timeSlot ? ' · ' + E(b.timeSlot) : ''}</dd><dt>Agreed price</dt><dd>${inr(b.price)}</dd></dl>
      ${b.cancellationReason ? `<div class="pay-note">Cancelled: ${E(b.cancellationReason)}</div>` : ''}
      <h4>Payment</h4>${p ? `<dl class="ac-dl"><dt>Payment</dt><dd>${E(p.paymentNumber)} ${badge(p.state.replace('_', ' ').toLowerCase(), PAY_TONE[p.state])}${p.disputed ? ' ' + badge('dispute', 'bad') : ''}</dd><dt>Customer paid</dt><dd>${inr(p.total)} (service ${inr(p.service)} + fee ${inr(p.platformFee)} + tax ${inr(p.tax)})</dd><dt>Refunded</dt><dd>${inr(p.refunded)}</dd>
        ${p.settlement ? `<dt>Worker settlement</dt><dd>${badge(p.settlement.status.replace(/_/g, ' ').toLowerCase(), SETTLE_TONE[p.settlement.status])}</dd><dt>Commission</dt><dd>${inr(p.settlement.commission)}</dd><dt>Worker net</dt><dd>${inr(p.settlement.workerNet)}</dd>` : ''}</dl>${p.disputeReason ? `<div class="pay-note warn">Dispute: ${E(p.disputeReason)} <a href="admin.html">Resolve in the Payments panel →</a></div>` : ''}` : '<p class="pay-sub">No payment has been made for this booking.</p>'}
      <h4>Status history</h4><ul class="ac-list">${b.history.map((h) => `<li>${h.from ? E(h.from.replace(/_/g, ' ').toLowerCase()) + ' → ' : ''}<b>${E(h.to.replace(/_/g, ' ').toLowerCase())}</b> · ${E(h.by)} · ${E(when(h.at))}${h.reason ? `<br><small>${E(h.reason)}</small>` : ''}</li>`).join('') || '<li>No history.</li>'}</ul>
      ${b.complaints.length ? `<h4>Complaints</h4><ul class="ac-list">${b.complaints.map((t) => `<li>${E(t.ticketNumber)} · ${E(t.subject)} ${badge(t.status.replace('_', ' ').toLowerCase(), 'warn')}</li>`).join('')}</ul>` : ''}
      <p class="ac-fine">${E(b.actions.note)}</p><div class="pay-actions"><button class="pay-btn ghost" type="button" data-x autofocus>Close</button></div>`);
  }

  // ── Finance ──────────────────────────────────────────────────────────────
  async function financeView() {
    const s = st.finance; loading();
    const [r, owed, sets] = await Promise.all([api('GET', `/finance/summary?${qs({ from: s.from, to: s.to })}`), api('GET', '/finance/owed-workers?limit=20'), api('GET', `/finance/settlements?${qs({ from: s.from, to: s.to, status: s.sStatus, page: s.sPage, limit: 10 })}`)]);
    if (!r.ok) return errorBox(r);
    const f = r.data.finance; const w = f.workers; const rec = f.reconciliation;
    view.innerHTML = `${rangeBar(s)}
      <p class="ac-fine" style="margin-bottom:10px">${E(f.basis)} ${f.paymentsCount ? `${num(f.paymentsCount)} payment(s).` : 'No payments were captured in this period.'}</p>
      <div class="ac-banner ${f.payouts.railActive ? 'ok' : 'warn'}"><b>${f.payouts.railActive ? 'Payouts: Razorpay Route.' : 'Payouts: ledger only.'}</b> ${E(f.payouts.note)}</div>
      <h2 class="ac-h2">Money received</h2>
      <div class="ac-grid">${kpi('Customer payment value', inr(f.customerPaymentValue), 'Service + platform fee + tax, as charged')}${kpi('Refunds', inr(f.refunds), 'Processed by Razorpay')}${kpi('Net cash received', inr(f.netCashReceived), 'Payments less refunds, before Razorpay\'s own charges', 'ok')}
        ${kpi('Razorpay charges', f.gatewayFees.paymentsReported ? inr(f.gatewayFees.reported) : 'Not reported', `${num(f.gatewayFees.paymentsReported)} payment(s) reported a fee; ${num(f.gatewayFees.paymentsNotReported)} did not (not estimated)`)}</div>
      <h2 class="ac-h2">What the money is made of</h2>
      <div class="ac-grid">${kpi('Gross service value', inr(f.grossServiceValue), `${inr(f.serviceValueRefunded)} refunded → ${inr(f.netServiceValue)} net`)}${kpi('Platform fees', inr(f.platformFeesNet), `${inr(f.platformFeesCollected)} collected, ${inr(f.platformFeesRefunded)} refunded`)}${kpi('Taxes held', inr(f.taxesNet), f.taxNote)}</div>
      <h2 class="ac-h2">LocalHire revenue</h2>
      <div class="ac-grid">${kpi('Configured commission', `${E(f.commission.configuredRatePercent)}%`, 'Deducted from each worker\'s service amount')}${kpi('Commission earned', inr(f.commission.earned), 'On jobs the customer confirmed, after refunds', 'ok')}${kpi('Commission pending', inr(f.commission.pending), 'Paid but not yet confirmed or in dispute: not earned')}
        ${kpi('Platform fees earned', inr(f.platformFeeRevenue.earned), `${inr(f.platformFeeRevenue.pending)} more pending`)}${kpi('Revenue earned', inr(f.localhireRevenueEarned), 'Commission + platform fees. Taxes are never revenue', 'ok')}</div>
      <h2 class="ac-h2">Worker settlements</h2>
      <div class="ac-grid">${kpi('Net entitlement', inr(w.netEntitlementTotal), 'What professionals have earned from these payments')}${kpi('Outstanding liability', inr(w.outstandingLiability), 'Not yet paid: pending, on hold, owed, processing and failed', w.outstandingLiability ? 'warn' : '')}
        ${kpi('Owed, not yet transferred', inr(w.owedNotYetTransferred), f.payouts.railActive ? 'Waiting for payout' : 'Needs the external payout process')}${kpi('Pending confirmation', inr(w.byStatus.PENDING_COMPLETION.amount), `${num(w.byStatus.PENDING_COMPLETION.count)} job(s); plus ${inr(w.byStatus.BLOCKED.amount)} on hold`)}
        ${kpi('Payouts in progress', inr(w.byStatus.PAYOUT_PROCESSING.amount))}${kpi('Actual payouts completed', inr(w.actualPayoutsCompleted), `${num(w.actualPayoutsCount)} settled`, 'ok')}${kpi('Failed payouts', inr(w.failedPayouts), `${num(w.failedPayoutsCount)} failed`, w.failedPayouts ? 'bad' : '')}</div>
      <div class="ac-card"><h3>Reconciliation</h3><p class="ac-fine" style="margin-bottom:6px">${E(f.cash.note)}</p>
        <dl class="ac-dl"><dt>Net cash received</dt><dd>${inr(rec.netCashReceived)}</dd><dt>= Worker net entitlement</dt><dd>${inr(rec.workerNetEntitlement)}</dd><dt>+ Commission (earned and pending)</dt><dd>${inr(rec.commission)}</dd><dt>+ Platform fees (net)</dt><dd>${inr(rec.platformFeesNet)}</dd><dt>+ Taxes held (net)</dt><dd>${inr(rec.taxesNet)}</dd><dt>Difference</dt><dd>${rec.difference === 0 ? badge('₹0.00: the books balance', 'ok') : badge(inr(rec.difference) + ' unexplained', 'bad')}</dd><dt>Paid out to workers so far</dt><dd>${inr(f.cash.paidOutToWorkers)}</dd><dt>Still held by LocalHire</dt><dd>${inr(f.cash.stillHeldByLocalHire)}</dd></dl></div>
      <h2 class="ac-h2">Professionals owed money</h2>
      ${owed.ok ? table([{ h: 'Professional', f: (x) => E(x.name) }, { h: 'Owed', num: true, f: (x) => inr(x.owed) }, { h: 'Processing', num: true, f: (x) => inr(x.processing) }, { h: 'Failed', num: true, f: (x) => inr(x.failed) }, { h: 'Total', num: true, f: (x) => `<b>${inr(x.total)}</b>` }, { h: 'Jobs', num: true, f: (x) => num(x.jobs) }], owed.data.workers, { emptyMsg: ['Nobody is owed money', 'Confirmed jobs appear here until they are paid out.'] }) : ''}
      <h2 class="ac-h2">Settlements</h2>
      <div class="ac-chips" role="group" aria-label="Settlement status">${[['', 'All'], ['PENDING_COMPLETION', 'Pending'], ['ELIGIBLE', 'Owed'], ['PAYOUT_PROCESSING', 'Processing'], ['PAID', 'Paid'], ['FAILED', 'Failed'], ['BLOCKED', 'On hold'], ['CANCELLED', 'Cancelled']].map(([v, l]) => `<button class="ac-chip" type="button" data-ss="${v}" aria-pressed="${s.sStatus === v}">${l}</button>`).join('')}</div>
      ${sets.ok ? table([{ h: 'Booking', f: (x) => `<b>${E(x.bookingNumber || '')}</b><small>${E(x.paymentNumber)}</small>` }, { h: 'Professional', f: (x) => E(x.worker) }, { h: 'Service', num: true, f: (x) => inr(x.serviceAmount) }, { h: 'Commission', num: true, f: (x) => inr(x.commission) }, { h: 'Refund adj.', num: true, f: (x) => (x.refundAdjustment ? '− ' + inr(x.refundAdjustment) : '–') }, { h: 'Net', num: true, f: (x) => `<b>${inr(x.netAmount)}</b>` }, { h: 'Status', f: (x) => `${badge(x.status.replace(/_/g, ' ').toLowerCase(), SETTLE_TONE[x.status])}${x.failureReason ? `<small>${E(x.failureReason)}</small>` : ''}` }], sets.data.settlements, { emptyMsg: ['No settlements', 'None match this status.'] }) + pager(sets.data) : ''}
      <p class="ac-fine">Refunds, dispute resolution and payout retries are in the <a href="admin.html">Payments panel</a>.</p>`;
    wireRange(s, financeView);
    view.querySelectorAll('[data-ss]').forEach((b) => b.addEventListener('click', () => { s.sStatus = b.dataset.ss; s.sPage = 1; financeView(); }));
    view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { s.sPage = Number(b.dataset.pg); financeView(); }));
  }

  // ── Categories ───────────────────────────────────────────────────────────
  async function categories() {
    loading();
    const r = await api('GET', '/categories'); if (!r.ok) return errorBox(r);
    categoriesCache = r.data.categories; const list = r.data.categories;
    view.innerHTML = `<div class="ac-bar"><button class="ac-btn" type="button" id="cat-new">+ New category</button><span class="ac-fine">Disabled categories are hidden from customers and new onboarding. Categories with history cannot be deleted, only disabled.</span></div>
      ${table([{ h: 'Category', f: (c) => `<span style="display:flex;gap:10px;align-items:center">${c.iconUrl ? `<img class="ac-icon" src="${E(c.iconUrl)}" alt="" data-initial="${E(c.name[0])}">` : `<span class="ac-icon" aria-hidden="true">${E(c.name[0])}</span>`}<span><b>${E(c.name)}</b><small>${E(c.description || 'No description')}</small></span></span>` },
        { h: 'Status', f: (c) => (c.isActive ? badge('enabled', 'ok') : badge('disabled', 'bad')) }, { h: 'Workers', num: true, f: (c) => num(c.counts.workers) }, { h: 'Bookings', num: true, f: (c) => num(c.counts.bookings) }, { h: 'Jobs', num: true, f: (c) => num(c.counts.jobs) }, { h: 'Order', num: true, f: (c) => num(c.displayOrder) },
        { h: '', f: (c) => `<button class="ac-btn sm ghost" type="button" data-edit="${E(c.id)}">Edit</button>` }], list, { emptyMsg: ['No categories', 'Create the first one.'] })}`;
    document.getElementById('cat-new').addEventListener('click', () => categoryForm(null));
    view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => categoryForm(list.find((c) => c.id === b.dataset.edit))));
  }

  function categoryForm(cat) {
    const dlg = detailDialog(`<h3 id="pay-title">${cat ? 'Edit category' : 'New category'}</h3>
      <label class="pay-field"><span>Name</span><input id="cf-name" maxlength="60" value="${E(cat ? cat.name : '')}"></label>
      <label class="pay-field"><span>Description (shown to customers)</span><textarea id="cf-desc" maxlength="500">${E(cat ? cat.description || '' : '')}</textarea></label>
      <label class="pay-field"><span>Display order</span><input id="cf-order" type="number" min="0" max="10000" value="${cat ? E(cat.displayOrder) : ''}" placeholder="Leave empty to add at the end"></label>
      ${cat ? `<label class="pay-field"><span>Icon / image (JPG, PNG or WebP, up to 2 MB)</span><input id="cf-icon" type="file" accept="image/jpeg,image/png,image/webp"></label>
        ${cat.iconUrl ? `<img class="ac-icon" src="${E(cat.iconUrl)}" alt="Current icon" style="width:56px;height:56px;margin-top:6px">` : ''}
        <label class="pay-field" style="display:flex;gap:8px;align-items:center"><input id="cf-active" type="checkbox" ${cat.isActive ? 'checked' : ''} style="width:auto"><span style="margin:0">Enabled</span></label>
        <div class="ac-fine">Used by ${num(cat.counts.workers)} professional(s), ${num(cat.counts.bookings)} booking(s).</div>` : ''}
      <div id="cf-err" class="pay-note err" role="alert" hidden></div>
      <div class="pay-actions">${cat ? '<button class="pay-btn danger" type="button" id="cf-del">Delete…</button>' : ''}<button class="pay-btn ghost" type="button" data-x>Cancel</button><button class="pay-btn primary" type="button" id="cf-save">Save</button></div>`);
    const err = (m) => { const e = dlg.el.querySelector('#cf-err'); e.hidden = !m; e.textContent = m || ''; };
    dlg.el.querySelector('#cf-save').addEventListener('click', async () => {
      err('');
      const name = dlg.el.querySelector('#cf-name').value.trim(); const description = dlg.el.querySelector('#cf-desc').value.trim(); const order = dlg.el.querySelector('#cf-order').value;
      const body = { name, description, ...(order !== '' ? { displayOrder: Number(order) } : {}) };
      let reason;
      if (cat) {
        const active = dlg.el.querySelector('#cf-active').checked;
        if (active !== cat.isActive) {
          if (!active) { const a = await reasonPrompt(`Disable ${cat.name}?`, 'It disappears from customer category lists and new onboarding. Existing professionals, bookings and history are kept.', 'Disable', true); if (!a.confirmed) return; reason = a.value.trim(); }
          body.isActive = active; if (reason) body.reason = reason;
        }
      }
      const res = cat ? await api('PATCH', `/categories/${encodeURIComponent(cat.id)}`, body) : await api('POST', '/categories', body);
      if (!res.ok) return err(res.data.message || 'Could not save.');
      const file = cat ? dlg.el.querySelector('#cf-icon').files[0] : null;
      if (file) {
        if (file.size > 2 * 1024 * 1024) return err('The image is larger than 2 MB (the other changes were saved).');
        const fd = new FormData(); fd.append('icon', file);
        const up = await api('POST', `/categories/${encodeURIComponent(cat.id)}/icon`, fd, true);
        if (!up.ok) return err(`${up.data.message || 'The icon could not be uploaded.'} (the other changes were saved)`);
      }
      toast(cat ? 'Category updated.' : 'Category created.'); dlg.close('saved'); categories();
    });
    const del = dlg.el.querySelector('#cf-del');
    if (del) del.addEventListener('click', async () => {
      const a = await P.ask({ title: `Delete ${cat.name}?`, message: 'This cannot be undone. A category that professionals, services, jobs or bookings refer to cannot be deleted.', confirmText: 'Delete', danger: true });
      if (!a.confirmed) return;
      const res = await api('DELETE', `/categories/${encodeURIComponent(cat.id)}`, {});
      if (res.ok) { toast('Category deleted.'); dlg.close('deleted'); categories(); } else err(res.data.message || 'Could not delete.');
    });
  }

  // ── Analytics ────────────────────────────────────────────────────────────
  async function analyticsView() {
    const s = st.analytics; loading();
    const r = await api('GET', `/analytics?${qs({ from: s.from, to: s.to, granularity: s.granularity })}`);
    if (!r.ok) { view.innerHTML = rangeBar(s, { granularity: true }); wireRange(s, analyticsView); view.insertAdjacentHTML('beforeend', `<div class="ac-banner err" role="alert">${E(r.data.message || 'Could not load analytics.')}</div>`); return; }
    const a = r.data; const labels = a.bookings.map((x) => x.bucket); const rt = a.rates;
    const rate = (o, label, sub) => kpi(label, o.rate === null ? '–' : `${o.rate}%`, sub);
    view.innerHTML = `${rangeBar(s, { granularity: true })}
      <p class="ac-fine" style="margin-bottom:10px">${E(a.range.from)} to ${E(a.range.to)} · ${a.range.buckets} ${a.range.granularity === 'month' ? 'month' : 'day'}${a.range.buckets === 1 ? '' : 's'} · time zone ${E(a.range.timezone)}</p>
      <div class="ac-rates" style="margin-bottom:14px">${rate(rt.acceptance, 'Worker acceptance rate', `${num(rt.acceptance.accepted)} accepted, ${num(rt.acceptance.declined)} declined`)}${rate(rt.cancellation, 'Cancellation rate', `${num(rt.cancellation.cancelled)} of ${num(rt.bookingsCreated)} bookings`)}${rate(rt.completion, 'Completed booking rate', `${num(rt.completion.completed)} of ${num(rt.bookingsCreated)} bookings`)}${kpi('Bookings created', num(rt.bookingsCreated), `${num(rt.disputed)} disputed`)}</div>
      <div class="ac-2col"><div class="ac-card"><h3>${a.range.granularity === 'month' ? 'Monthly' : 'Daily'} bookings</h3><div class="ac-chart" id="ch-bk"></div></div>
        <div class="ac-card"><h3>Revenue trend</h3><p class="ac-fine" style="margin-bottom:6px">${E(a.revenue.basis)}</p><div class="ac-chart" id="ch-rev"></div></div></div>
      <div class="ac-2col"><div class="ac-card"><h3>Popular service categories</h3><div class="ac-chart" id="ch-cat"></div></div><div class="ac-card"><h3>Top localities</h3><p class="ac-fine" style="margin-bottom:6px">By the customer's service address (city and PIN code).</p><div class="ac-chart" id="ch-loc"></div></div></div>
      <div class="ac-2col"><div class="ac-card"><h3>Customer growth</h3><div class="ac-chart" id="ch-cg"></div></div><div class="ac-card"><h3>Worker growth</h3><div class="ac-chart" id="ch-wg"></div></div></div>`;
    wireRange(s, analyticsView);
    const $ = (id) => document.getElementById(id);
    C.timeSeries($('ch-bk'), { title: 'Bookings', labels, series: [{ name: 'Created', values: a.bookings.map((x) => x.total), type: 'bar', color: '#5b3df5' }, { name: 'Completed', values: a.bookings.map((x) => x.completed), type: 'line', color: '#12805c' }, { name: 'Cancelled', values: a.bookings.map((x) => x.cancelled), type: 'line', color: '#ef4444' }] });
    C.timeSeries($('ch-rev'), { title: 'Revenue trend', money: true, labels, series: [{ name: 'Gross service value', values: a.revenue.series.map((x) => x.grossServiceValue), type: 'bar', color: '#c7bffd' }, { name: 'Commission earned', values: a.revenue.series.map((x) => x.commissionEarned), type: 'line', color: '#12805c' }, { name: 'Refunds', values: a.revenue.series.map((x) => x.refunds), type: 'line', color: '#ef4444' }] });
    C.hbars($('ch-cat'), { title: 'Popular categories', rows: a.popularCategories.map((c) => ({ label: c.name, value: c.bookings, sub: `${num(c.completed)} completed · ${inr(c.completedValue)} service value` })) });
    C.hbars($('ch-loc'), { title: 'Top localities', rows: a.topLocalities.map((l) => ({ label: `${l.city} ${l.postalCode}`, value: l.bookings, sub: `${num(l.completed)} completed · ${inr(l.completedValue)}` })), empty: 'No bookings with a service address in this period.' });
    C.timeSeries($('ch-cg'), { title: 'Customer growth', labels, series: [{ name: 'New customers', values: a.customerGrowth.map((x) => x.newCustomers), type: 'bar', color: '#5b3df5' }, { name: 'Total customers', values: a.customerGrowth.map((x) => x.totalCustomers), type: 'line', color: '#12805c' }] });
    C.timeSeries($('ch-wg'), { title: 'Worker growth', labels, series: [{ name: 'New workers', values: a.workerGrowth.map((x) => x.newWorkers), type: 'bar', color: '#f59e0b' }, { name: 'Total workers', values: a.workerGrowth.map((x) => x.totalWorkers), type: 'line', color: '#0ea5e9' }] });
  }

  // ── Audit log ────────────────────────────────────────────────────────────
  async function audit() {
    const s = st.audit; loading();
    const r = await api('GET', `/audit-logs?${qs({ action: s.action, page: s.page, limit: 15 })}`); if (!r.ok) return errorBox(r);
    const d = r.data;
    view.innerHTML = `<form class="ac-bar" id="af"><label class="ac-field">Action<select class="ac-select" name="action"><option value="">All</option>${['WORKER_SUSPENDED', 'WORKER_REACTIVATED', 'CUSTOMER_SUSPENDED', 'CUSTOMER_REACTIVATED', 'CUSTOMER_PROFILE_VIEWED', 'CATEGORY_CREATED', 'CATEGORY_UPDATED', 'CATEGORY_DELETED', 'PAYMENT_REFUND_INITIATED', 'PAYMENT_DISPUTE_RESOLVED'].map((a) => `<option value="${a}" ${s.action === a ? 'selected' : ''}>${a.replace(/_/g, ' ').toLowerCase()}</option>`).join('')}</select></label><button class="ac-btn" type="submit">Filter</button></form>
      ${table([{ h: 'When', f: (l) => E(when(l.at)) }, { h: 'Who', f: (l) => `${E(l.actor || 'System')}${l.actorRole ? `<small>${E(l.actorRole.toLowerCase())}</small>` : ''}` }, { h: 'Action', f: (l) => badge(l.action.replace(/_/g, ' ').toLowerCase(), 'info') }, { h: 'Subject', f: (l) => `${E(l.entityType.toLowerCase())}<small>${E(l.entityId)}</small>` }, { h: 'Reason', f: (l) => E(l.reason || '–') }], d.logs, { emptyMsg: ['No log entries', 'Sensitive admin actions appear here.'] })}${pager(d)}`;
    const f = document.getElementById('af'); f.addEventListener('submit', (e) => { e.preventDefault(); s.action = f.action.value; s.page = 1; audit(); });
    view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { s.page = Number(b.dataset.pg); audit(); }));
  }

  // ── Reviews: moderation ──────────────────────────────────────────────────
  // Admins can inspect, hide and restore reviews and resolve reports, always with a reason that is audit-logged.
  // There is no edit or delete: the review text, its reports and the moderation history are always preserved.
  const RV_FILTERS = [['', 'All'], ['REPORTED', 'Reported'], ['PUBLISHED', 'Published'], ['HIDDEN', 'Hidden']];
  const RV_TONE = { PUBLISHED: 'ok', REPORTED: 'warn', HIDDEN: 'bad' };
  const REPORT_LABEL = { ABUSIVE: 'Abusive or hateful', FAKE_OR_FRAUDULENT: 'Fake or fraudulent', NOT_MY_CUSTOMER: 'Not my customer', PRIVATE_INFORMATION: 'Private information', OTHER: 'Other' };
  const stars = (n) => '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
  const snippet = (t, n = 110) => (String(t || '').length > n ? `${String(t).slice(0, n - 1)}\u2026` : String(t || ''));

  async function reviews() {
    const s = st.reviews; loading();
    const r = await api('GET', `/reviews?${qs({ state: s.state, rating: s.rating, q: s.q, page: s.page, limit: 12 })}`);
    if (!r.ok) return errorBox(r);
    const d = r.data; const c = d.counts;
    const label = (v, l) => (v === 'REPORTED' ? `${l} (${num(c.reported)})` : v === 'HIDDEN' ? `${l} (${num(c.hidden)})` : v === '' ? `${l} (${num(c.all)})` : l);
    view.innerHTML = `${c.reported ? `<div class="ac-banner warn" role="status"><b>${num(c.reported)} review${c.reported === 1 ? '' : 's'} reported by professionals</b> waiting for a decision.</div>` : ''}
      <div class="ac-chips" role="group" aria-label="Review state">${RV_FILTERS.map(([v, l]) => `<button class="ac-chip" type="button" data-f="${v}" aria-pressed="${s.state === v}">${label(v, l)}</button>`).join('')}</div>
      <form class="ac-bar" id="rf" role="search"><label class="ac-field">Search<input class="ac-input" name="q" value="${E(s.q || '')}" placeholder="Review text, professional, customer or booking no."></label>
        <label class="ac-field">Rating<select class="ac-select" name="rating"><option value="">Any</option>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${String(s.rating) === String(n) ? 'selected' : ''}>${n} star${n > 1 ? 's' : ''}</option>`).join('')}</select></label>
        <button class="ac-btn" type="submit">Apply</button><button class="ac-btn ghost" type="button" id="rf-clear">Clear</button></form>
      ${table([{ h: 'Review', f: (x) => `<span style="color:#f5a524" aria-label="${x.rating} out of 5">${stars(x.rating)}</span><small style="color:var(--ac-ink)">${E(snippet(x.comment))}</small>` },
        { h: 'Professional', f: (x) => E(x.worker ? x.worker.name : '–') }, { h: 'Customer', f: (x) => E(x.customer || '–') },
        { h: 'Booking', f: (x) => E(x.bookingNumber || '–') },
        { h: 'State', f: (x) => `${badge(x.state.toLowerCase(), RV_TONE[x.state])}${x.openReports ? `<small>${num(x.openReports)} open report${x.openReports === 1 ? '' : 's'}</small>` : ''}` },
        { h: 'Date', f: (x) => E(day(x.createdAt)) }], d.reviews, { onRow: true, emptyMsg: ['No reviews match', s.state || s.q || s.rating ? 'Try clearing the filters.' : 'Reviews appear here after customers rate completed jobs.'] })}
      ${pager(d)}
      <p class="ac-fine">Hidden reviews stop counting towards public ratings but are never deleted. Every moderation action needs a reason and is recorded in the audit log.</p>`;
    view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { s.state = b.dataset.f; s.page = 1; reviews(); }));
    const f = document.getElementById('rf');
    f.addEventListener('submit', (e) => { e.preventDefault(); s.q = f.q.value.trim(); s.rating = f.rating.value; s.page = 1; reviews(); });
    document.getElementById('rf-clear').addEventListener('click', () => { st.reviews = { page: 1, state: s.state }; reviews(); });
    view.querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => { s.page = Number(b.dataset.pg); reviews(); }));
    wireRows(view, d.reviews, (x) => reviewDetail(x.id));
  }

  async function reviewDetail(id) {
    const dlg = detailDialog('<div class="pay-spin" role="status" aria-label="Loading"></div>');
    const r = await api('GET', `/reviews/${encodeURIComponent(id)}`);
    if (!r.ok) { dlg.set(`<button class="pay-x" type="button" data-x aria-label="Close">&times;</button><h3 id="pay-title">Could not load review</h3><div class="pay-note err">${E(r.data.message || '')}</div>`); return; }
    const v = r.data.review; const b = v.booking;
    const open = v.reports.filter((x) => x.status === 'OPEN').length;
    dlg.set(`<button class="pay-x" type="button" aria-label="Close" data-x>&times;</button><h3 id="pay-title">Review of ${E(v.worker ? v.worker.name : 'professional')}</h3>
      <p class="pay-sub">${badge(v.state.toLowerCase(), RV_TONE[v.state])} <span style="color:#f5a524" aria-label="${v.rating} out of 5">${stars(v.rating)}</span> ${E(day(v.createdAt))}</p>
      ${v.state === 'HIDDEN' ? `<div class="pay-note err"><b>Hidden</b> ${E(day(v.hiddenAt))}: ${E(v.hiddenReason || '')}<br><small>It does not count towards the professional's rating or appear publicly.</small></div>` : ''}
      <blockquote style="margin:8px 0 12px;padding:10px 12px;background:#f9fafb;border-left:3px solid #d0d5dd;white-space:pre-line;overflow-wrap:anywhere">${E(v.comment)}</blockquote>
      <dl class="ac-dl"><dt>Customer</dt><dd>${E(v.customer || '–')}</dd><dt>Booking</dt><dd>${E(b.number)} ${statusBadge(b.status)}</dd><dt>Service</dt><dd>${E(b.service || '–')}</dd><dt>Job completed</dt><dd>${E(day(b.completedAt))}</dd></dl>
      <p class="ac-fine">The review is tied to this completed booking. Customer contact details are not shown here.</p>
      <h4>Reports from the professional (${v.reports.length})</h4>
      <ul class="ac-list">${v.reports.length ? v.reports.map((x) => `<li>${badge(x.status.toLowerCase(), x.status === 'OPEN' ? 'warn' : x.status === 'UPHELD' ? 'bad' : '')} <b>${E(REPORT_LABEL[x.reason] || x.reason)}</b> · ${E(x.reporter || 'Professional')} · ${E(when(x.createdAt))}${x.details ? `<br>${E(x.details)}` : ''}${x.resolutionNote ? `<br><small>Decision: ${E(x.resolutionNote)}</small>` : ''}</li>`).join('') : '<li>No reports.</li>'}</ul>
      <h4>Moderation history</h4>
      <ul class="ac-list">${v.history.length ? v.history.map((h) => `<li><b>${E(h.action.replace(/_/g, ' ').toLowerCase())}</b> by ${E(h.actor || 'an administrator')} · ${E(when(h.at))}<br><small>${E(h.reason)}</small></li>`).join('') : '<li>No moderation actions yet.</li>'}</ul>
      <div class="pay-actions">${v.state === 'HIDDEN' ? '<button class="pay-btn primary" type="button" data-act="restore">Restore review</button>' : '<button class="pay-btn danger" type="button" data-act="hide">Hide review</button>'}${open ? '<button class="pay-btn ghost" type="button" data-act="dismiss-reports">Dismiss reports</button>' : ''}<button class="pay-btn ghost" type="button" data-x>Close</button></div>`);
    const COPY = {
      hide: ['Hide this review?', `It stops counting towards ${E(v.worker ? v.worker.name : 'the professional')}'s rating and disappears from their public profile. The text and history are kept.${open ? ' Open reports are marked upheld.' : ''}`, 'Hide review', true],
      restore: ['Restore this review?', 'It counts towards the rating again and is shown publicly.', 'Restore review', false],
      'dismiss-reports': ['Dismiss the reports?', 'The review stays published. The professional is told their report was reviewed.', 'Dismiss reports', false]
    };
    dlg.el.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const [t, m, ok, danger] = COPY[a.dataset.act];
      const ans = await reasonPrompt(t, m, ok, danger);
      if (!ans.confirmed) return;
      a.disabled = true;
      const res = await api('POST', `/reviews/${encodeURIComponent(id)}/${a.dataset.act}`, { reason: ans.value.trim() });
      if (res.ok) { toast(res.data.message); dlg.close('done'); reviews(); } else { a.disabled = false; toast(res.data.message || 'Failed', 'err'); }
    });
  }

  // ── Router ───────────────────────────────────────────────────────────────
  const ROUTES = { overview: ['Overview', overview], workers: ['Workers', workers], customers: ['Customers', customers], bookings: ['Bookings', bookings], reviews: ['Reviews', reviews], finance: ['Financial management', financeView], categories: ['Service categories', categories], analytics: ['Analytics', analyticsView], audit: ['Audit log', audit] };
  function route() {
    const key = (window.location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    const [name, fn] = ROUTES[key] || ROUTES.overview;
    title.textContent = name; document.title = `${name} | LocalHire Admin`;
    document.querySelectorAll('#ac-nav a[data-r]').forEach((a) => { if (a.dataset.r === (ROUTES[key] ? key : 'overview')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    closeMenu(); fn();
  }
  const side = document.getElementById('ac-side'); const menu = document.getElementById('ac-menu');
  const closeMenu = () => { side.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); };
  menu.addEventListener('click', () => { const open = side.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('hashchange', route);
  route();
}());
