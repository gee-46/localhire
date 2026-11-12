// LocalHire payments (browser side).
//
// Responsibilities: show the server-computed price breakdown, open Razorpay Checkout for a server-created order,
// and report the result to the server. The browser is NEVER the source of truth: it sends no amounts, and a
// "payment successful" callback is only a hint that makes the server ask Razorpay what really happened.
// No secrets live here; the only key is the public Razorpay key id returned by the server.
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => {
    const v = Number(n || 0);
    return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  };
  const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium' }) : '');

  const token = () => { try { return window.sessionStorage.getItem('localHire_token'); } catch (e) { return null; } };

  // → { ok, status, data }. Network failure → { ok:false, status:0, data:{message} }.
  async function call(method, path, body) {
    try {
      const res = await fetch(`${window.location.origin}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) {
      return { ok: false, status: 0, data: { message: 'Could not reach LocalHire. Check your connection and try again.' } };
    }
  }

  // ── Labels ────────────────────────────────────────────────────────────────
  const PAYMENT_LABEL = {
    CREATED: ['Payment pending', 'warn'], AUTHORIZED: ['Authorised', 'info'], CAPTURED: ['Paid', 'ok'], FAILED: ['Payment failed', 'err'],
    REFUNDED: ['Refunded', 'info'], PARTIALLY_REFUNDED: ['Partly refunded', 'info']
  };
  const badge = (state) => {
    const [label, tone] = PAYMENT_LABEL[state] || [String(state || '').replace(/_/g, ' ').toLowerCase(), ''];
    return `<span class="pay-badge ${tone}">${esc(label)}</span>`;
  };
  const refundBadge = (status) => {
    if (status === 'REFUND_IN_PROGRESS') return '<span class="pay-badge warn">Refund in progress</span>';
    if (status === 'REFUNDED') return '<span class="pay-badge info">Fully refunded</span>';
    if (status === 'PARTIALLY_REFUNDED') return '<span class="pay-badge info">Partially refunded</span>';
    return '';
  };
  const SETTLEMENT_LABEL = {
    PENDING_COMPLETION: ['Held until the customer confirms the job', 'warn'], ELIGIBLE: ['Confirmed. Owed to you, not yet transferred', 'info'],
    PAYOUT_PROCESSING: ['Payout processing', 'info'], PAID: ['Paid out', 'ok'], FAILED: ['Payout failed', 'err'], REVERSED: ['Payout reversed', 'err'],
    BLOCKED: ['On hold: dispute under review', 'warn'], CANCELLED: ['Refunded to the customer', '']
  };
  const settlementBadge = (status) => {
    const [label, tone] = SETTLEMENT_LABEL[status] || [String(status || ''), ''];
    return `<span class="pay-badge ${tone}">${esc(label)}</span>`;
  };

  // ── Dialog plumbing ───────────────────────────────────────────────────────
  let openCount = 0;
  function dialog(html, { onClose, labelledBy = 'pay-title', dismissable = true } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'pay-overlay';
    overlay.innerHTML = `<div class="pay-modal" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}" tabindex="-1"></div>`;
    const box = overlay.firstElementChild;
    const previouslyFocused = document.activeElement;
    let closed = false;
    const api = {
      el: box,
      set(htmlNext) { box.innerHTML = htmlNext; const f = box.querySelector('[autofocus],button,input,textarea'); if (f) f.focus(); },
      close(reason) {
        if (closed) return; closed = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove(); openCount -= 1;
        if (!openCount) document.body.style.overflow = '';
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        if (onClose) onClose(reason);
      },
      dismissable
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && api.dismissable) { e.stopPropagation(); api.close('escape'); }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...box.querySelectorAll('a[href],button:not([disabled]),input,textarea,select,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const first = f[0]; const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && api.dismissable) api.close('backdrop'); });
    document.addEventListener('keydown', onKey, true);
    box.innerHTML = html;
    document.body.appendChild(overlay); openCount += 1; document.body.style.overflow = 'hidden';
    const f = box.querySelector('[autofocus]') || box.querySelector('button, input, textarea');
    (f || box).focus();
    return api;
  }

  // Generic question: resolves to { confirmed, value }.
  function ask({ title, message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false, input = null }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (confirmed, value) => { if (done) return; done = true; dlg.close('answered'); resolve({ confirmed, value }); };
      const field = input
        ? `<label class="pay-field"><span>${esc(input.label)}</span>${input.multiline
          ? `<textarea id="pay-ask-input" maxlength="${input.maxLength || 500}" placeholder="${esc(input.placeholder || '')}">${esc(input.value || '')}</textarea>`
          : `<input id="pay-ask-input" type="${input.type || 'text'}" ${input.min != null ? `min="${input.min}"` : ''} ${input.step ? `step="${input.step}"` : ''} value="${esc(input.value == null ? '' : input.value)}" placeholder="${esc(input.placeholder || '')}" inputmode="${input.type === 'number' ? 'decimal' : 'text'}">`}
          ${input.help ? `<small class="pay-sub">${esc(input.help)}</small>` : ''}<small id="pay-ask-err" class="pay-sub" style="color:#b42318" role="alert"></small></label>` : '';
      const dlg = dialog(`
        <button class="pay-x" type="button" aria-label="Close" data-no>&times;</button>
        <h3 id="pay-title">${esc(title)}</h3>
        ${message ? `<p class="pay-sub" style="margin-top:6px">${message}</p>` : ''}${field}
        <div class="pay-actions"><button class="pay-btn ghost" type="button" data-no>${esc(cancelText)}</button>
        <button class="pay-btn ${danger ? 'danger' : 'primary'}" type="button" data-yes autofocus>${esc(confirmText)}</button></div>`, { onClose: () => finish(false) });
      dlg.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-no]')) finish(false);
        if (e.target.closest('[data-yes]')) {
          if (!input) return finish(true);
          const el = dlg.el.querySelector('#pay-ask-input');
          const err = input.validate ? input.validate(el.value) : null;
          if (err) { dlg.el.querySelector('#pay-ask-err').textContent = err; el.focus(); return; }
          finish(true, el.value);
        }
      });
    });
  }

  // ── Razorpay Checkout ─────────────────────────────────────────────────────
  let checkoutLoading = null;
  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve(true);
    if (checkoutLoading) return checkoutLoading;
    checkoutLoading = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload = () => resolve(Boolean(window.Razorpay));
      s.onerror = () => { checkoutLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return checkoutLoading;
  }

  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';

  function breakdownTable(b) {
    const fee = Number(b.platformFee) > 0;
    const tax = Number(b.taxAmount) > 0;
    return `<table class="pay-table" aria-label="Price breakdown"><tbody>
      <tr><td>Service amount<small>Price confirmed by the professional</small></td><td>${inr(b.serviceAmount)}</td></tr>
      ${fee ? `<tr><td>Platform fee${b.platformFeePercent ? ` (${b.platformFeePercent}%)` : ''}</td><td>${inr(b.platformFee)}</td></tr>` : ''}
      ${tax ? `<tr><td>Taxes${b.taxPercentOnFee ? ` (${b.taxPercentOnFee}% on platform fee)` : ''}</td><td>${inr(b.taxAmount)}</td></tr>` : ''}
      <tr class="pay-total"><td>Total payable</td><td>${inr(b.totalAmount)}</td></tr></tbody></table>`;
  }

  // Main entry. Resolves { paid: boolean } when the dialog is closed.
  function openPayModal({ bookingId, onDone } = {}) {
    return new Promise((resolve) => {
      let paid = false;
      let busy = false;
      let quote = null;
      const dlg = dialog('<div class="pay-spin" role="status" aria-label="Loading"></div>', {
        onClose: () => { resolve({ paid }); if (paid && onDone) onDone(); }
      });
      const lock = (v) => { busy = v; dlg.dismissable = !v; };
      const close = () => dlg.close('done');

      const showReady = (message) => {
        const b = quote.breakdown;
        const w = quote.booking.worker || {};
        const bk = quote.booking;
        dlg.set(`
          <button class="pay-x" type="button" aria-label="Close" data-close>&times;</button>
          <h3 id="pay-title">Pay for your booking</h3>
          <p class="pay-sub">Review the amount below, then pay securely with Razorpay.</p>
          <div class="pay-party"><div class="pay-avatar">${w.avatarUrl ? `<img src="${esc(w.avatarUrl)}" alt="">` : esc(initials(w.name))}</div>
            <div><strong>${esc(w.name || 'Professional')}</strong><span class="pay-sub">${esc(w.profession || 'Service professional')}</span></div></div>
          <div class="pay-booking"><div><b>${esc(bk.service)}</b></div><div>Booking ${esc(bk.bookingNumber)}</div><div>${esc(day(bk.scheduledAt))}${bk.timeSlot && bk.timeSlot !== 'Flexible' ? ` · ${esc(bk.timeSlot)}` : ''}</div></div>
          ${b ? breakdownTable(b) : ''}
          ${message ? `<div class="pay-note ${message.tone || ''}" role="alert">${esc(message.text)}</div>` : ''}
          ${quote.payable.ok
            ? `<div class="pay-note">You pay LocalHire through Razorpay. The professional is paid after you confirm the job is done. Payment methods shown are those enabled for LocalHire.</div>
               <div class="pay-actions"><button class="pay-btn ghost" type="button" data-close>Not now</button><button class="pay-btn primary" type="button" data-pay autofocus>Pay ${inr(b.totalAmount)}</button></div>`
            : `<div class="pay-note warn" role="alert">${esc(quote.payable.reason)}</div><div class="pay-actions"><button class="pay-btn ghost" type="button" data-close autofocus>Close</button></div>`}`);
      };

      const showSuccess = (p) => {
        paid = true;
        dlg.set(`
          <div class="pay-center"><div class="pay-big-icon ok" aria-hidden="true">✓</div>
          <h3 id="pay-title">Payment received</h3>
          <p class="pay-sub" style="margin-top:6px">${inr(p.totalAmount)} paid${p.methodDetail ? ` with ${esc(p.methodDetail)}` : ''}. The professional has been notified.</p></div>
          <div class="pay-note ok">When the work is finished, come back and press <b>Confirm completion</b>. Your payment is released to the professional only then.</div>
          <div class="pay-actions"><button class="pay-btn primary" type="button" data-close autofocus>Done</button></div>`);
      };

      const showFailure = (text) => {
        dlg.set(`
          <div class="pay-center"><div class="pay-big-icon err" aria-hidden="true">!</div>
          <h3 id="pay-title">Payment not completed</h3>
          <p class="pay-sub" style="margin-top:6px" role="alert">${esc(text)}</p></div>
          <div class="pay-actions"><button class="pay-btn ghost" type="button" data-close>Close</button><button class="pay-btn primary" type="button" data-retry autofocus>Try again</button></div>`);
      };

      // The server may still be waiting for Razorpay: ask it a few times before giving up.
      const confirming = async () => {
        lock(true);
        dlg.set('<div class="pay-center"><div class="pay-spin" role="status" aria-label="Confirming"></div><h3 id="pay-title">Confirming your payment…</h3><p class="pay-sub">This usually takes a few seconds. Please do not close this window.</p></div>');
        for (let i = 0; i < 8; i += 1) {
          await new Promise((r) => setTimeout(r, i === 0 ? 800 : 2500));
          const r = await call('POST', `/payments/booking/${bookingId}/sync`);
          const p = r.data && r.data.payment;
          if (p && ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(p.state)) { lock(false); return showSuccess(p); }
          if (p && p.state === 'FAILED') { lock(false); return showFailure(p.failureReason || 'The payment failed.'); }
        }
        lock(false);
        dlg.set(`<div class="pay-center"><div class="pay-big-icon wait" aria-hidden="true">…</div><h3 id="pay-title">Still confirming</h3>
          <p class="pay-sub" style="margin-top:6px">We have not received confirmation from Razorpay yet. If money left your account it will be matched to this booking automatically, or refunded. You can safely close this window and check <b>My Jobs</b> later.</p></div>
          <div class="pay-actions"><button class="pay-btn primary" type="button" data-close autofocus>Close</button></div>`);
      };

      const startPayment = async () => {
        if (busy) return;
        lock(true);
        const payBtn = dlg.el.querySelector('[data-pay]');
        if (payBtn) { payBtn.disabled = true; payBtn.textContent = 'Opening secure checkout…'; }
        const [order, loaded] = await Promise.all([call('POST', `/payments/booking/${bookingId}/order`), loadCheckout()]);
        if (!order.ok) { lock(false); await refresh({ text: order.data.message || 'Could not start the payment.', tone: 'err' }); return; }
        if (!loaded) { lock(false); showReady({ text: 'Razorpay Checkout could not be loaded. Check your connection and try again.', tone: 'err' }); return; }

        const o = order.data;
        let sawFailure = null;
        let handled = false;
        const rzp = new window.Razorpay({
          key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: 'LocalHire',
          description: `Booking ${o.booking.bookingNumber}`, prefill: o.prefill, theme: { color: '#5b3df5' },
          handler: async (resp) => {
            handled = true;
            dlg.set('<div class="pay-center"><div class="pay-spin" role="status" aria-label="Verifying"></div><h3 id="pay-title">Verifying your payment…</h3></div>');
            const v = await call('POST', `/payments/booking/${bookingId}/verify`, {
              razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature
            });
            if (v.status === 202) return confirming();
            lock(false);
            if (v.ok && v.data.confirmed) return showSuccess(v.data.payment);
            if (v.ok && v.data.authorized) return confirming();
            return showFailure(v.data.message || 'We could not verify this payment.');
          },
          modal: {
            escape: true,
            ondismiss: async () => {
              if (handled) return;
              // Closed without paying, or a failed attempt: let the server look at the order and record what happened.
              const s = await call('POST', `/payments/booking/${bookingId}/sync`);
              const p = s.data && s.data.payment;
              lock(false);
              if (p && ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(p.state)) return showSuccess(p);
              await refresh(sawFailure ? { text: `${sawFailure} No money was taken for this attempt. You can try again.`, tone: 'err' } : { text: 'Checkout was closed before the payment was completed.', tone: 'warn' });
            }
          }
        });
        rzp.on('payment.failed', (r) => { sawFailure = (r && r.error && r.error.description) || 'The payment failed.'; });
        rzp.open();
      };

      const refresh = async (message) => {
        const q = await call('GET', `/payments/booking/${bookingId}/quote`);
        if (!q.ok) { dlg.set(`<button class="pay-x" type="button" aria-label="Close" data-close>&times;</button><h3 id="pay-title">Payment unavailable</h3><div class="pay-note err" role="alert">${esc(q.data.message || 'Could not load the payment details.')}</div><div class="pay-actions"><button class="pay-btn ghost" type="button" data-close autofocus>Close</button></div>`); return; }
        quote = q.data;
        if (quote.payment && ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(quote.payment.state)) return showSuccess(quote.payment);
        showReady(message);
      };

      dlg.el.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) { if (!busy) close(); }
        else if (e.target.closest('[data-pay]')) startPayment();
        else if (e.target.closest('[data-retry]')) { refresh(); }
      });
      refresh();
    });
  }

  // ── Completion / dispute ──────────────────────────────────────────────────
  async function confirmCompletion({ bookingId, workerName, amountLabel }) {
    const a = await ask({
      title: 'Confirm the service is complete?',
      message: `Only confirm if ${esc(workerName || 'the professional')} has finished the job to your satisfaction${amountLabel ? ` (${esc(amountLabel)})` : ''}. This releases their earnings and cannot be undone. If something is wrong, choose <b>Report a problem</b> instead.`,
      confirmText: 'Yes, it is complete'
    });
    if (!a.confirmed) return { done: false, cancelled: true };
    const r = await call('POST', `/payments/booking/${bookingId}/confirm-completion`);
    return { done: r.ok, message: r.data.message || (r.ok ? 'Confirmed.' : 'Could not confirm completion.') };
  }

  async function reportProblem({ bookingId }) {
    const a = await ask({
      title: 'Report a problem',
      message: 'Describe what went wrong. The payment is put on hold and an LocalHire administrator will review it. This does not cancel the booking.',
      confirmText: 'Open dispute', danger: true,
      input: { label: 'What happened?', multiline: true, maxLength: 1000, placeholder: 'e.g. The tap is still leaking after the repair', validate: (v) => (v.trim().length < 10 ? 'Please describe the problem in at least 10 characters.' : null) }
    });
    if (!a.confirmed) return { done: false, cancelled: true };
    const r = await call('POST', `/payments/booking/${bookingId}/dispute`, { reason: a.value.trim() });
    return { done: r.ok, message: r.data.message || (r.ok ? 'Dispute opened.' : 'Could not open the dispute.') };
  }

  // Worker accepts a request and confirms the price the customer will be asked to pay.
  async function confirmPrice({ requestedPrice }) {
    const a = await ask({
      title: 'Accept and confirm your price',
      message: 'The customer will be asked to pay this amount (platform fee and taxes are added on top and shown to them). You can confirm the requested price or enter a different one.',
      confirmText: 'Accept booking',
      input: {
        label: 'Service price (₹)', type: 'number', min: 50, step: '0.01', value: requestedPrice, help: 'Between ₹50 and ₹5,00,000.',
        validate: (v) => { const n = Number(v); return !Number.isFinite(n) || n < 50 || n > 500000 || Math.round(n * 100) !== n * 100 ? 'Enter a price between ₹50 and ₹5,00,000 (max two decimals).' : null; }
      }
    });
    return a.confirmed ? { confirmed: true, price: Number(a.value) } : { confirmed: false };
  }

  // Compact "money block" for a booking card. `payment` is the role-specific summary from the bookings API.
  function bookingMoneyHtml({ role, booking, payment }) {
    if (role === 'Worker') {
      if (!payment) return booking.status === 'CONFIRMED' || booking.status === 'DISPATCHED' || booking.status === 'IN_PROGRESS'
        ? '<div class="pay-line"><span class="pay-badge warn">Waiting for the customer to pay</span></div>' : '';
      const s = payment.settlement;
      const lines = [];
      lines.push(payment.paid ? '<span class="pay-badge ok">Customer has paid</span>' : (payment.state === 'FAILED' ? '<span class="pay-badge err">Customer payment failed</span>' : '<span class="pay-badge warn">Waiting for the customer to pay</span>'));
      if (payment.refundPending) lines.push('<span class="pay-badge warn">Refund in progress</span>');
      let html = `<div class="pay-line">${lines.join('')}</div>`;
      if (s && s.status !== 'CANCELLED' && payment.paid) html += `<div class="pay-line"><span>Your earnings <b>${inr(s.netAmount)}</b></span>${settlementBadge(s.status)}</div>`;
      else if (s && s.status === 'CANCELLED') html += `<div class="pay-line">${settlementBadge('CANCELLED')}</div>`;
      if (s && s.status === 'FAILED') html += '<div class="pay-hint">The payout failed. LocalHire has been alerted and will retry; no action is needed unless you are asked.</div>';
      return html;
    }
    // customer
    if (!payment || payment.state === 'CREATED') return '';
    const bits = [badge(payment.state)];
    if (payment.refundPending) bits.push('<span class="pay-badge warn">Refund in progress</span>');
    let html = `<div class="pay-line"><span>${payment.paid ? `Paid <b>${inr(payment.totalAmount)}</b>` : 'Payment'}</span><span>${bits.join(' ')}</span></div>`;
    if (payment.amountRefunded > 0) html += `<div class="pay-line"><span class="pay-hint">Refunded ${inr(payment.amountRefunded)}</span></div>`;
    if (payment.state === 'FAILED' && payment.failureReason) html += `<div class="pay-hint">${esc(payment.failureReason)}</div>`;
    return html;
  }

  window.LocalHirePayments = {
    call, inr, when, day, esc, badge, refundBadge, settlementBadge, ask, dialog,
    openPayModal, confirmCompletion, reportProblem, confirmPrice, bookingMoneyHtml, loadCheckout
  };
}());
