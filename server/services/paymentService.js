// Customer payments: Razorpay order creation, server-side verification, the payment state machine, refunds,
// cancellation handling and webhook processing.
//
// Principles:
//  * The browser is never trusted. A payment is only CAPTURED after the SERVER has confirmed it with Razorpay
//    (API fetch after a verified Checkout signature, or a signed webhook).
//  * Payment state (CREATED, AUTHORIZED, CAPTURED, FAILED, REFUNDED, PARTIALLY_REFUNDED) is independent of booking status.
//  * Every mutation runs under a row lock and writes an append-only ledger entry; webhooks are processed at most once.
const crypto = require('crypto');
const {
  prisma, PaymentError, fail, gateway, payoutMode, lockPayment, lockBooking, recordTx, audit, notify, round2, num,
  PAYABLE_BOOKING_STATUSES, CAPTURED_FAMILY
} = require('./paymentCore');
const { getRazorpayCredentials, isRazorpayConfigured, getRazorpayMode, verifyPaymentSignature } = require('../config/razorpay');
const pricing = require('./pricing');
const settlements = require('./settlementService');
const payoutAccounts = require('./payoutAccountService');

const TX_OPTS = { maxWait: 10000, timeout: 25000 };
const RATE = () => pricing.getRates();

// ── Quote / eligibility ──────────────────────────────────────────────────────

const loadBooking = (id) => prisma.booking.findUnique({
  where: { id: String(id) },
  include: {
    payment: true,
    worker: { select: { id: true, name: true, avatarUrl: true, workerProfile: { select: { primaryCategory: { select: { name: true } } } } } },
    customer: { select: { id: true, name: true, email: true, phone: true } },
    serviceItem: { select: { id: true, title: true } },
    address: { select: { street: true, city: true, postalCode: true } }
  }
});

// Why a booking can or cannot be paid right now. `code` is stable for the UI.
const evaluatePayable = async (booking) => {
  const p = booking.payment;
  if (p && ['CAPTURED', 'AUTHORIZED', 'PARTIALLY_REFUNDED'].includes(p.state)) return { ok: false, code: 'ALREADY_PAID', reason: 'This booking has already been paid.' };
  if (p && p.state === 'REFUNDED') return { ok: false, code: 'REFUNDED', reason: 'This payment was refunded.' };
  if (booking.status === 'REQUESTED') return { ok: false, code: 'AWAITING_WORKER', reason: 'The professional has not accepted this request yet. You can pay once they accept and confirm the price.' };
  if (!PAYABLE_BOOKING_STATUSES.includes(booking.status)) return { ok: false, code: 'BAD_BOOKING_STATUS', reason: `A booking that is ${booking.status.toLowerCase().replace(/_/g, ' ')} cannot be paid.` };
  if (!booking.priceConfirmedAt) return { ok: false, code: 'PRICE_NOT_CONFIRMED', reason: 'The professional has not confirmed the price yet.' };
  if (!(num(booking.agreedPrice) > 0)) return { ok: false, code: 'INVALID_AMOUNT', reason: 'The booking has no valid price.' };
  if (payoutMode() === 'ROUTE') {
    const acc = await settlements.activePayoutAccount(booking.workerId);
    if (!acc) return { ok: false, code: 'WORKER_PAYOUT_NOT_READY', reason: 'This professional has not finished setting up payouts, so they cannot receive payments yet.' };
  }
  return { ok: true, code: null, reason: null };
};

const breakdownView = (b) => ({
  currency: 'INR',
  serviceAmount: pricing.fromPaise(b.servicePaise),
  platformFee: pricing.fromPaise(b.platformFeePaise),
  taxAmount: pricing.fromPaise(b.taxPaise),
  totalAmount: pricing.fromPaise(b.totalPaise),
  platformFeePercent: b.rates.platformFeePercent,
  taxPercentOnFee: b.rates.platformFeeTaxPercent
});

const bookingSummary = (booking) => ({
  id: booking.id, bookingNumber: booking.bookingNumber, status: booking.status, scheduledAt: booking.scheduledAt, timeSlot: booking.timeSlot,
  service: (booking.serviceItem && booking.serviceItem.title) || booking.problemDescription || 'Service booking',
  worker: { id: booking.worker.id, name: booking.worker.name, avatarUrl: booking.worker.avatarUrl, profession: booking.worker.workerProfile && booking.worker.workerProfile.primaryCategory ? booking.worker.workerProfile.primaryCategory.name : null }
});

const assertCustomerOwner = (booking, user) => {
  if (!booking) fail(404, 'Booking not found.', 'NOT_FOUND');
  if (booking.customerId !== user.id) fail(403, 'Only the customer who made this booking can pay for it.', 'FORBIDDEN');
};

const getQuote = async ({ bookingId, user }) => {
  const booking = await loadBooking(bookingId);
  assertCustomerOwner(booking, user);
  const payable = await evaluatePayable(booking);
  const breakdown = num(booking.agreedPrice) > 0 ? breakdownView(pricing.computeBreakdown(num(booking.agreedPrice))) : null;
  return { booking: bookingSummary(booking), breakdown, payable, payment: booking.payment ? serializeForCustomer(booking.payment) : null };
};

// ── Order creation (idempotent) ──────────────────────────────────────────────

// Razorpay reports its own fee (and the tax on it) on the payment entity, in paise, once it is known.
const gatewayFeeData = (e) => (e && Number.isFinite(Number(e.fee)) && e.fee !== null
  ? { gatewayFee: pricing.fromPaise(e.fee), gatewayFeeTax: Number.isFinite(Number(e.tax)) ? pricing.fromPaise(e.tax) : null } : {});

const methodInfo = (e) => {
  const method = e.method || null;
  let detail = null;
  if (method === 'card' && e.card) detail = `${e.card.network || 'Card'} ••••${e.card.last4 || ''}`.trim();
  else if (method === 'upi') detail = 'UPI';
  else if (method === 'netbanking') detail = e.bank ? `Net banking (${e.bank})` : 'Net banking';
  else if (method === 'wallet') detail = e.wallet ? `Wallet (${e.wallet})` : 'Wallet';
  else if (method) detail = method;
  return { method, methodDetail: detail };
};

const createOrder = async ({ bookingId, user }) => {
  const g = gateway();
  // Reconcile any earlier attempt first, so a payment that completed in another tab/device is never paid twice.
  const pre = await prisma.payment.findUnique({ where: { bookingId: String(bookingId) } });
  if (pre && pre.gatewayOrderId && ['CREATED', 'FAILED'].includes(pre.state)) {
    await syncOrder({ paymentId: pre.id }).catch((e) => console.warn('[Payments] pre-order sync failed:', e.message));
  }

  const out = await prisma.$transaction(async (tx) => {
    await lockBooking(tx, String(bookingId));
    const booking = await tx.booking.findUnique({
      where: { id: String(bookingId) },
      include: { payment: true, worker: { select: { id: true, name: true } }, customer: { select: { id: true, name: true, email: true, phone: true } } }
    });
    assertCustomerOwner(booking, user);
    const payable = await evaluatePayable(booking);
    if (!payable.ok) fail(payable.code === 'ALREADY_PAID' || payable.code === 'REFUNDED' ? 409 : 400, payable.reason, payable.code);

    const b = pricing.computeBreakdown(num(booking.agreedPrice));
    const amounts = pricing.breakdownRupees(b);
    const existing = booking.payment;

    // Reuse the open order when nothing changed: no duplicate orders for one booking.
    if (existing && existing.state === 'CREATED' && existing.gatewayOrderId && pricing.toPaise(num(existing.totalAmount)) === b.totalPaise) {
      return { payment: existing, booking, b, reused: true };
    }

    const attempt = existing ? existing.attempts + 1 : 1;
    const paymentNumber = existing ? existing.paymentNumber : `PAY-${new Date().getFullYear()}-${crypto.randomInt(100000, 999999)}`;
    let order;
    try {
      order = await g.orders.create({
        amount: b.totalPaise, currency: 'INR',
        receipt: `${booking.bookingNumber}-${attempt}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40),
        notes: { bookingId: booking.id, paymentNumber, customerId: booking.customerId, workerId: booking.workerId }
      });
    } catch (e) {
      console.error('[Payments] order creation failed:', e && (e.error || e.message));
      fail(502, 'The payment gateway could not create the order. Please try again.', 'GATEWAY_ERROR');
    }
    const data = { ...amounts, state: 'CREATED', gatewayOrderId: order.id, gatewayPaymentId: null, attempts: attempt, failedAt: null, failureCode: null, failureReason: null, method: null, methodDetail: null };
    const payment = existing
      ? await tx.payment.update({ where: { id: existing.id }, data })
      : await tx.payment.create({ data: { paymentNumber, bookingId: booking.id, customerId: booking.customerId, workerId: booking.workerId, currency: 'INR', ...data } });
    await recordTx(tx, { paymentId: payment.id, type: 'ORDER_CREATED', amount: amounts.totalAmount, gatewayRef: order.id, note: `Attempt ${attempt}`, actorId: user.id });
    return { payment, booking, b, reused: false };
  }, TX_OPTS);

  const { keyId } = getRazorpayCredentials();
  return {
    orderId: out.payment.gatewayOrderId, amount: pricing.toPaise(num(out.payment.totalAmount)), currency: 'INR', keyId, mode: getRazorpayMode(),
    breakdown: breakdownView(out.b), booking: bookingSummary(await loadBooking(bookingId)),
    prefill: { name: out.booking.customer.name || '', email: out.booking.customer.email || '', contact: out.booking.customer.phone && !/00000/.test(out.booking.customer.phone) ? out.booking.customer.phone : '' },
    reused: out.reused
  };
};

// ── Applying gateway truth to our records ────────────────────────────────────

// `entity` is a Razorpay payment entity fetched by the server or delivered in a signed webhook.
const applyGatewayPayment = async (paymentId, entity) => {
  if (!entity || !entity.id) return { ignored: true };
  const result = await prisma.$transaction(async (tx) => {
    await lockPayment(tx, paymentId);
    const p = await tx.payment.findUnique({ where: { id: paymentId } });
    if (!p) return { ignored: true };

    if (entity.order_id !== p.gatewayOrderId) return { staleOrder: true, payment: p };
    if (entity.amount !== undefined && Number(entity.amount) !== pricing.toPaise(num(p.totalAmount))) {
      console.warn(`[Payments] amount mismatch for ${p.paymentNumber}: gateway ${entity.amount}, expected ${pricing.toPaise(num(p.totalAmount))}`);
      await recordTx(tx, { paymentId: p.id, type: 'FAILED', gatewayRef: `mismatch-${entity.id}`, note: 'Gateway amount did not match the order; ignored' });
      return { ignored: true, mismatch: true };
    }
    if (entity.currency && entity.currency !== 'INR') return { ignored: true, mismatch: true };

    const already = CAPTURED_FAMILY.includes(p.state) || p.state === 'AUTHORIZED';
    if (already && p.gatewayPaymentId && p.gatewayPaymentId !== entity.id && ['authorized', 'captured'].includes(entity.status)) {
      return { duplicate: true, payment: p };
    }

    const { method, methodDetail } = methodInfo(entity);
    const data = {};
    let becameCaptured = false;
    let needsCapture = false;
    const isCaptured = entity.status === 'captured' || entity.captured === true;

    if (isCaptured) {
      if (['CREATED', 'AUTHORIZED', 'FAILED'].includes(p.state)) {
        Object.assign(data, { state: 'CAPTURED', capturedAt: new Date(), gatewayPaymentId: entity.id, method, methodDetail, failedAt: null, failureCode: null, failureReason: null, ...gatewayFeeData(entity) });
        if (!p.authorizedAt) data.authorizedAt = new Date();
        becameCaptured = true;
        await recordTx(tx, { paymentId: p.id, type: 'CAPTURED', amount: p.totalAmount, gatewayRef: entity.id, note: method ? `Paid by ${methodDetail || method}` : null });
        await settlements.ensureSettlement(tx, { ...p, ...data });
      }
    } else if (entity.status === 'authorized') {
      if (['CREATED', 'FAILED'].includes(p.state)) {
        Object.assign(data, { state: 'AUTHORIZED', authorizedAt: new Date(), gatewayPaymentId: entity.id, method, methodDetail, failedAt: null, failureCode: null, failureReason: null });
        await recordTx(tx, { paymentId: p.id, type: 'AUTHORIZED', amount: p.totalAmount, gatewayRef: entity.id });
        needsCapture = true;
      } else if (p.state === 'AUTHORIZED') needsCapture = true;
    } else if (entity.status === 'failed') {
      if (p.state === 'CREATED') {
        Object.assign(data, { state: 'FAILED', failedAt: new Date(), failureCode: entity.error_code || null, failureReason: entity.error_description || 'Payment failed' });
        await recordTx(tx, { paymentId: p.id, type: 'FAILED', amount: p.totalAmount, gatewayRef: entity.id, note: entity.error_description || 'Payment failed' });
      }
    }
    // Razorpay often reports its fee only after capture: record it when a later fetch/webhook carries it
    if (CAPTURED_FAMILY.includes(p.state) && p.gatewayFee === null && p.gatewayPaymentId === entity.id) Object.assign(data, gatewayFeeData(entity));
    const updated = Object.keys(data).length ? await tx.payment.update({ where: { id: p.id }, data }) : p;
    return { payment: updated, becameCaptured, needsCapture, entityId: entity.id };
  }, TX_OPTS);

  if (result.staleOrder) return result;
  if (result.duplicate) { await refundDuplicatePayment(result.payment, entity); return { duplicate: true, payment: result.payment }; }
  if (result.ignored) return result;

  if (result.needsCapture && result.payment.state === 'AUTHORIZED') {
    // The account may use manual capture: capture exactly the order amount, server-side.
    try {
      const captured = await gateway().payments.capture(result.entityId, pricing.toPaise(num(result.payment.totalAmount)), 'INR');
      return applyGatewayPayment(paymentId, captured);
    } catch (e) {
      console.warn('[Payments] capture of authorized payment failed:', e && (e.error || e.message));
    }
  }
  if (result.becameCaptured) await onCaptured(result.payment);
  return result;
};

const onCaptured = async (payment) => {
  const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId } });
  if (booking && booking.status === 'CANCELLED') {
    // Money arrived for a booking that was cancelled in the meantime: give it straight back.
    await issueRefund({ paymentId: payment.id, kind: 'LATE_PAYMENT', reason: 'Payment received after the booking was cancelled', actor: null }).catch((e) => console.error('[Payments] late-payment refund failed:', e.message));
    return;
  }
  const s = await prisma.workerSettlement.findUnique({ where: { paymentId: payment.id } });
  if (s && payoutMode() === 'ROUTE') await settlements.createHeldTransfer(s.id).catch((e) => console.error('[Payments] held transfer failed:', e.message));
  await Promise.all([
    notify({ userId: payment.customerId, type: 'PAYMENT_HELD', bookingId: payment.bookingId, title: 'Payment successful', message: `We received your payment of ₹${num(payment.totalAmount)}. Confirm the job once it is done; the professional is paid only after that.` }),
    notify({ userId: payment.workerId, type: 'PAYMENT_HELD', bookingId: payment.bookingId, title: 'Booking payment confirmed', message: 'The customer has paid for this booking. You can start the service; your earnings are released when they confirm the job is done.' })
  ]);
};

// Checkout callback: authentic (signature checked against OUR order id), then confirmed with Razorpay by the server.
const verifyCheckout = async ({ bookingId, orderId, paymentId, signature, user }) => {
  const booking = await prisma.booking.findUnique({ where: { id: String(bookingId) }, include: { payment: true } });
  assertCustomerOwner(booking, user);
  const p = booking.payment;
  if (!p || !p.gatewayOrderId) fail(404, 'No payment order exists for this booking.', 'NO_ORDER');
  if (orderId && orderId !== p.gatewayOrderId) fail(400, 'Payment verification failed: order does not match this booking.', 'ORDER_MISMATCH');
  if (!verifyPaymentSignature({ orderId: p.gatewayOrderId, paymentId, signature })) {
    console.warn('[Payments] invalid checkout signature for booking', bookingId);
    await audit('PAYMENT_SIGNATURE_REJECTED', p.id, { paymentId }, user);
    fail(400, 'Payment verification failed: invalid signature. Transaction rejected.', 'INVALID_SIGNATURE');
  }
  let entity;
  try {
    entity = await gateway().payments.fetch(paymentId);
  } catch (e) {
    // Authentic callback but we could not reach Razorpay: do NOT mark anything paid. The webhook will settle it.
    return { confirmed: false, pending: true, payment: serializeForCustomer(p), message: 'Your payment is being confirmed. This page will update as soon as Razorpay confirms it.' };
  }
  const r = await applyGatewayPayment(p.id, entity);
  if (r.staleOrder) fail(400, 'Payment verification failed: this payment belongs to a different order.', 'ORDER_MISMATCH');
  if (r.mismatch) fail(400, 'Payment verification failed: amount or currency mismatch.', 'AMOUNT_MISMATCH');
  const fresh = await prisma.payment.findUnique({ where: { id: p.id } });
  return { confirmed: CAPTURED_FAMILY.includes(fresh.state), authorized: fresh.state === 'AUTHORIZED', payment: serializeForCustomer(fresh), duplicate: Boolean(r.duplicate) };
};

// Ask Razorpay what happened to this order and record it (failed attempts, late captures). The server decides.
const syncOrder = async ({ paymentId, bookingId, user }) => {
  let p;
  if (paymentId) p = await prisma.payment.findUnique({ where: { id: paymentId } });
  else {
    const booking = await prisma.booking.findUnique({ where: { id: String(bookingId) }, include: { payment: true } });
    assertCustomerOwner(booking, user);
    p = booking.payment;
  }
  if (!p || !p.gatewayOrderId) return { payment: p ? serializeForCustomer(p) : null };
  const resp = await gateway().orders.fetchPayments(p.gatewayOrderId);
  const items = ((resp && resp.items) || []).slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  for (const entity of items) {
    const r = await applyGatewayPayment(p.id, entity);
    if (r.staleOrder) await handleStaleOrderPayment(r.payment, entity);
  }
  return { payment: serializeForCustomer(await prisma.payment.findUnique({ where: { id: p.id } })) };
};

// A payment on an order that is not the booking's current one (e.g. an older tab).
const handleStaleOrderPayment = async (payment, entity) => {
  if (!['authorized', 'captured'].includes(entity.status)) return;
  if (CAPTURED_FAMILY.includes(payment.state) || payment.state === 'AUTHORIZED') { await refundDuplicatePayment(payment, entity); return; }
  const bookingOk = entity.notes && entity.notes.bookingId === payment.bookingId;
  if (bookingOk && Number(entity.amount) === pricing.toPaise(num(payment.totalAmount))) {
    await prisma.payment.update({ where: { id: payment.id }, data: { gatewayOrderId: entity.order_id } });
    await applyGatewayPayment(payment.id, entity);
  }
};

// ── Refunds ──────────────────────────────────────────────────────────────────

const issueRefund = async ({ paymentId, amountRupees = null, kind, reason, actor }) => {
  const g = gateway();
  const reserved = await prisma.$transaction(async (tx) => {
    await lockPayment(tx, paymentId);
    const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
    if (!p) fail(404, 'Payment not found.', 'NOT_FOUND');
    if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(p.state)) fail(409, 'Only a captured payment can be refunded.', 'NOT_REFUNDABLE');
    const counted = p.refunds.filter((r) => r.kind !== 'DUPLICATE_PAYMENT' && r.status !== 'FAILED');
    const remaining = round2(num(p.totalAmount) - counted.reduce((a, r) => a + num(r.amount), 0));
    if (remaining <= 0) fail(409, 'This payment has already been fully refunded.', 'ALREADY_REFUNDED');
    const amount = amountRupees === null || amountRupees === undefined ? remaining : round2(amountRupees);
    if (!(amount > 0)) fail(400, 'Refund amount must be greater than zero.', 'BAD_AMOUNT');
    if (amount > remaining + 0.0001) fail(409, `Refund exceeds the refundable balance of ₹${remaining}.`, 'EXCEEDS_REFUNDABLE');
    const refund = await tx.paymentRefund.create({
      data: {
        paymentId: p.id, amount, kind, reason: reason ? String(reason).slice(0, 500) : null, receipt: `rf_${p.paymentNumber}_${p.refunds.length + 1}`.slice(0, 40),
        gatewayPaymentId: p.gatewayPaymentId, initiatedById: actor && actor.id ? actor.id : null
      }
    });
    await recordTx(tx, { paymentId: p.id, type: 'REFUND_INITIATED', amount, gatewayRef: `local-${refund.id}`, note: `${kind}: ${reason || ''}`.slice(0, 200), actorId: actor && actor.id });
    return { payment: p, refund };
  }, TX_OPTS).catch((e) => {
    if (e && e.code === 'P2002') throw new PaymentError(409, 'A refund for this payment is already being created. Try again in a moment.', 'REFUND_IN_PROGRESS');
    throw e;
  });

  const { payment, refund } = reserved;
  const failRefund = async (message) => {
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { status: 'FAILED', failureReason: String(message).slice(0, 300) } });
    await prisma.$transaction((tx) => recordTx(tx, { paymentId: payment.id, type: 'REFUND_FAILED', amount: refund.amount, gatewayRef: `local-${refund.id}`, note: String(message).slice(0, 200) }));
  };

  // If a Route transfer already carries the worker's share, take it back first (best effort, never silent).
  try { await reverseWorkerShare(payment, refund); } catch (e) {
    await failRefund(`Could not reverse the worker transfer: ${e.message}`);
    fail(502, 'The refund could not start because the worker payout could not be reversed. An administrator must resolve this.', 'REVERSAL_FAILED');
  }

  let entity;
  try {
    entity = await g.payments.refund(payment.gatewayPaymentId, {
      amount: pricing.toPaise(num(refund.amount)), speed: 'normal', receipt: refund.receipt,
      notes: { refundId: refund.id, bookingId: payment.bookingId, kind }
    });
  } catch (e) {
    const msg = (e && e.error && e.error.description) || (e && e.message) || 'gateway error';
    await failRefund(msg);
    await audit('PAYMENT_REFUND_FAILED', payment.id, { refundId: refund.id, message: msg }, actor);
    fail(502, `The refund could not be created: ${msg}`, 'GATEWAY_ERROR');
  }
  await prisma.paymentRefund.update({ where: { id: refund.id }, data: { gatewayRefundId: entity.id, status: entity.status === 'processed' ? 'PROCESSED' : 'PENDING', processedAt: entity.status === 'processed' ? new Date() : null } });
  await audit('PAYMENT_REFUND_INITIATED', payment.id, { refundId: refund.id, amount: num(refund.amount), kind, reason }, actor);
  if (entity.status === 'processed') await finalizeRefund(refund.id);
  else await notify({ userId: payment.customerId, type: 'SYSTEM_ALERT', category: 'PAYMENT', bookingId: payment.bookingId, title: 'Refund initiated', message: `A refund of ₹${num(refund.amount)} has been initiated. Refunds usually reach your account within 5-7 working days.`, linkUrl: '/pages/payments.html' });
  return prisma.paymentRefund.findUnique({ where: { id: refund.id } });
};

const reverseWorkerShare = async (payment, refund) => {
  if (payoutMode() !== 'ROUTE') return;
  const route = require('./routeClient');
  const s = await prisma.workerSettlement.findUnique({ where: { paymentId: payment.id } });
  if (!s || !s.gatewayTransferId) return;
  const before = num(s.netAmount);
  const done = await prisma.paymentRefund.findMany({ where: { paymentId: payment.id, status: 'PROCESSED', kind: { not: 'DUPLICATE_PAYMENT' } }, orderBy: { createdAt: 'asc' }, select: { amount: true, kind: true } });
  const after = pricing.settlementAfterRefunds({
    serviceRupees: num(s.serviceAmount), commissionRatePercent: num(s.commissionRate), amountRefundedRupees: round2(num(payment.amountRefunded) + num(refund.amount)),
    serviceRefundedRupees: pricing.serviceRefundedFor({ serviceRupees: num(s.serviceAmount), platformFeeRupees: num(payment.platformFee), taxRupees: num(payment.taxAmount), refunds: [...done, { amount: refund.amount, kind: refund.kind }] })
  }).netAmount;
  const delta = pricing.toPaise(before - after);
  if (delta <= 0) return;
  await route.reverseTransfer(s.gatewayTransferId, delta, { refundId: refund.id });
  await prisma.$transaction((tx) => recordTx(tx, { paymentId: payment.id, type: 'TRANSFER_REVERSED', amount: pricing.fromPaise(delta), gatewayRef: `rev-${refund.id}`, note: 'Worker share reversed for refund' }));
};

// A refund reached its final state at the provider. Money effects are applied exactly once: the unique ledger
// entry (paymentId, REFUND_PROCESSED, refund id) is the guard, so replayed webhooks and retries are no-ops.
const finalizeRefund = async (refundId) => {
  const info = await prisma.$transaction(async (tx) => {
    const r0 = await tx.paymentRefund.findUnique({ where: { id: refundId } });
    if (!r0) return null;
    await lockPayment(tx, r0.paymentId);
    const marker = await tx.paymentTransaction.createMany({
      data: [{ paymentId: r0.paymentId, type: 'REFUND_PROCESSED', amount: r0.amount, gatewayRef: r0.gatewayRefundId || `local-${r0.id}`, note: `${r0.kind} refund processed` }],
      skipDuplicates: true
    });
    if (marker.count === 0) return { already: true };
    const r = await tx.paymentRefund.update({ where: { id: refundId }, data: { status: 'PROCESSED', processedAt: r0.processedAt || new Date(), failureReason: null } });
    if (r.kind === 'DUPLICATE_PAYMENT') {
      await recordTx(tx, { paymentId: r.paymentId, type: 'DUPLICATE_PAYMENT_REFUNDED', amount: r.amount, gatewayRef: r.gatewayPaymentId || '', note: 'A second payment for the same booking was refunded' });
      return { duplicate: true, refund: r };
    }
    const p = await tx.payment.findUnique({ where: { id: r.paymentId } });
    const refunded = round2(num(p.amountRefunded) + num(r.amount));
    const state = refunded >= num(p.totalAmount) - 0.0001 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const payment = await tx.payment.update({ where: { id: p.id }, data: { amountRefunded: refunded, state } });
    await settlements.applyRefundToSettlement(tx, payment);
    return { refund: r, payment };
  }, TX_OPTS);

  if (info && info.refund && info.payment) {
    await releaseResolvedSettlement(info.payment.id);
    await releaseCancellationFee(info.payment, info.refund);
    await notify({ userId: info.payment.customerId, type: 'REFUND_PROCESSED', bookingId: info.payment.bookingId, title: 'Refund processed', message: `₹${num(info.refund.amount)} has been refunded for your booking. It can take a few days to show in your account.` });
    await notify({ userId: info.payment.workerId, type: 'EARNINGS_UPDATED', bookingId: info.payment.bookingId, title: 'Earnings adjusted for a refund', message: 'A payment for one of your bookings was refunded to the customer, so your earnings for it were adjusted.' });
  }
  return info;
};

// After an admin resolved a dispute in the worker's favour (possibly with a partial refund), the settlement is
// released only once any refund has been applied, so the worker is never paid the pre-refund amount.
const releaseResolvedSettlement = async (paymentId) => {
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { settlement: true, refunds: true } });
  if (!p || p.disputed || !p.settlement || p.settlement.status !== 'BLOCKED') return;
  if (p.refunds.some((r) => r.status === 'PENDING' && r.kind !== 'DUPLICATE_PAYMENT')) return;
  const booking = await prisma.booking.findUnique({ where: { id: p.bookingId } });
  if (!booking || booking.status !== 'COMPLETED') return;
  const moved = await prisma.workerSettlement.updateMany({ where: { id: p.settlement.id, status: 'BLOCKED' }, data: { status: 'ELIGIBLE', eligibleAt: new Date() } });
  if (moved.count === 1) await settlements.dispatchPayout(p.settlement.id, null);
};

// A customer cancelled after the professional was on the way and forfeited a fee: the professional keeps that share, and the
// booking is over, so the (reduced) settlement is now owed instead of waiting forever for a completion that cannot happen.
const releaseCancellationFee = async (payment, refund) => {
  if (refund.kind !== 'CUSTOMER_CANCELLATION' || payment.state !== 'PARTIALLY_REFUNDED') return;
  const booking = await prisma.booking.findUnique({ where: { id: payment.bookingId }, select: { status: true } });
  if (!booking || booking.status !== 'CANCELLED') return;
  const s = await prisma.workerSettlement.findUnique({ where: { paymentId: payment.id } });
  if (!s || s.status !== 'PENDING_COMPLETION' || payment.disputed) return;
  const moved = await prisma.workerSettlement.updateMany({ where: { id: s.id, status: 'PENDING_COMPLETION' }, data: { status: 'ELIGIBLE', eligibleAt: new Date() } });
  if (moved.count === 1) {
    await audit('CANCELLATION_FEE_RELEASED', payment.id, { settlementId: s.id, net: num(s.netAmount) }, null);
    await settlements.dispatchPayout(s.id, null);
  }
};

const failRefundFromGateway = async (refundId, reason) => {
  const r = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
  if (!r || r.status === 'FAILED' || r.status === 'PROCESSED') return;
  await prisma.paymentRefund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: String(reason || 'Refund failed at the provider').slice(0, 300) } });
  await prisma.$transaction((tx) => recordTx(tx, { paymentId: r.paymentId, type: 'REFUND_FAILED', amount: r.amount, gatewayRef: r.gatewayRefundId || `local-${r.id}`, note: reason }));
  await audit('PAYMENT_REFUND_FAILED', r.paymentId, { refundId, reason });
};

// A second successful payment for a booking that is already paid: refund it automatically.
const refundDuplicatePayment = async (payment, entity) => {
  const receipt = `dup_${entity.id}`.slice(0, 40);
  const exists = await prisma.paymentRefund.findUnique({ where: { receipt } });
  if (exists) return exists;
  const g = gateway();
  try {
    if (entity.status === 'authorized') await g.payments.capture(entity.id, Number(entity.amount), 'INR');
    const refund = await prisma.paymentRefund.create({
      data: { paymentId: payment.id, amount: pricing.fromPaise(entity.amount), kind: 'DUPLICATE_PAYMENT', reason: 'Duplicate payment for an already-paid booking', receipt, gatewayPaymentId: entity.id }
    });
    const rf = await g.payments.refund(entity.id, { amount: Number(entity.amount), speed: 'normal', receipt, notes: { bookingId: payment.bookingId, kind: 'DUPLICATE_PAYMENT' } });
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { gatewayRefundId: rf.id, status: rf.status === 'processed' ? 'PROCESSED' : 'PENDING', processedAt: rf.status === 'processed' ? new Date() : null } });
    await prisma.$transaction((tx) => recordTx(tx, { paymentId: payment.id, type: 'REFUND_INITIATED', amount: refund.amount, gatewayRef: rf.id, note: 'Duplicate payment auto-refund' }));
    if (rf.status === 'processed') await finalizeRefund(refund.id);
    await audit('DUPLICATE_PAYMENT_REFUNDED', payment.id, { duplicatePaymentId: entity.id }, null);
    await notify({ userId: payment.customerId, type: 'REFUND_PROCESSED', bookingId: payment.bookingId, title: 'Duplicate payment refunded', message: 'You paid twice for the same booking. The second payment is being refunded automatically.', linkUrl: '/pages/payments.html' });
    return refund;
  } catch (e) {
    console.error('[Payments] duplicate payment refund failed:', e && (e.error || e.message));
    await audit('DUPLICATE_PAYMENT_REFUND_FAILED', payment.id, { duplicatePaymentId: entity.id, error: String((e && e.message) || e) }, null);
    return null;
  }
};

// Booking was cancelled: return the customer's money according to who cancelled.
const handleBookingCancelled = async ({ bookingId, previousStatus, actor }) => {
  let p = await prisma.payment.findUnique({ where: { bookingId } });
  if (!p) return null;
  if (p.state === 'AUTHORIZED') {
    // not yet captured: ask the gateway, it may capture right now (a late capture is also refunded by onCaptured)
    await syncOrder({ paymentId: p.id }).catch(() => {});
    p = await prisma.payment.findUnique({ where: { bookingId } });
  }
  if (!['CAPTURED', 'PARTIALLY_REFUNDED'].includes(p.state)) return null;
  const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
  const customerCancelled = actor && actor.id === booking.customerId;
  const kind = customerCancelled ? 'CUSTOMER_CANCELLATION' : (actor && actor.role === 'Admin' ? 'ADMIN' : 'WORKER_CANCELLATION');
  let amount = null; // null = everything still refundable
  if (customerCancelled && ['DISPATCHED', 'IN_PROGRESS'].includes(previousStatus)) {
    const fee = pricing.fromPaise(pricing.pctOf(pricing.toPaise(num(p.serviceAmount)), RATE().customerCancellationFeePercent));
    if (fee > 0) amount = round2(num(p.totalAmount) - num(p.amountRefunded) - fee);
  }
  if (amount !== null && amount <= 0) return null;
  const reason = customerCancelled ? 'Cancelled by the customer' : 'Booking cancelled by the professional/admin';
  return issueRefund({ paymentId: p.id, amountRupees: amount, kind, reason, actor }).catch(async (e) => {
    console.error('[Payments] cancellation refund failed:', e.message);
    await audit('CANCELLATION_REFUND_FAILED', p.id, { bookingId, error: e.message }, actor);
    return null;
  });
};

// ── Dispute resolution (admin) ───────────────────────────────────────────────

const resolveDispute = async ({ paymentId, decision, amountRupees, reason, admin }) => {
  const note = String(reason || '').trim().slice(0, 500);
  if (note.length < 5) fail(400, 'Please record the reason for this decision.', 'REASON_REQUIRED');
  const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: { settlement: true } });
  if (!p) fail(404, 'Payment not found.', 'NOT_FOUND');
  if (!p.disputed) fail(409, 'This payment has no open dispute.', 'NOT_DISPUTED');
  if (!['RELEASE_TO_WORKER', 'REFUND_FULL', 'REFUND_PARTIAL'].includes(decision)) fail(400, 'decision must be RELEASE_TO_WORKER, REFUND_FULL or REFUND_PARTIAL.', 'BAD_DECISION');
  if (decision === 'REFUND_PARTIAL' && !(Number(amountRupees) > 0 && Number(amountRupees) < num(p.totalAmount))) fail(400, 'A partial refund must be more than zero and less than the total paid.', 'BAD_AMOUNT');

  const closeBooking = async (status, why) => {
    const booking = await prisma.booking.findUnique({ where: { id: p.bookingId } });
    await prisma.booking.update({ where: { id: booking.id }, data: { status, ...(status === 'COMPLETED' ? { completedAt: booking.completedAt || new Date() } : { cancelledAt: new Date(), cancellationReason: why }), statusHistory: { create: { fromStatus: booking.status, toStatus: status, changedById: admin.id, reason: why } } } });
  };
  const closeTicket = (status) => prisma.supportTicket.updateMany({ where: { bookingId: p.bookingId, status: { in: ['OPEN', 'UNDER_REVIEW'] } }, data: { status, resolutionNotes: note } });

  if (decision === 'REFUND_FULL') {
    await issueRefund({ paymentId, kind: 'ADMIN', reason: `Dispute resolved: ${note}`, actor: admin });
    await prisma.payment.update({ where: { id: paymentId }, data: { disputed: false } });
    await closeBooking('CANCELLED', `Dispute resolved with a full refund: ${note}`);
    await closeTicket('RESOLVED_REFUND');
  } else if (decision === 'REFUND_PARTIAL') {
    await issueRefund({ paymentId, amountRupees: Number(amountRupees), kind: 'ADMIN', reason: `Dispute resolved (partial): ${note}`, actor: admin });
    await prisma.payment.update({ where: { id: paymentId }, data: { disputed: false } });
    await closeBooking('COMPLETED', `Dispute resolved with a partial refund: ${note}`);
    await closeTicket('RESOLVED_REFUND');
    await releaseResolvedSettlement(paymentId);
  } else {
    await prisma.payment.update({ where: { id: paymentId }, data: { disputed: false } });
    await closeBooking('COMPLETED', `Dispute resolved in the professional's favour: ${note}`);
    await closeTicket('RESOLVED_PAYOUT');
    await releaseResolvedSettlement(paymentId);
  }
  await audit('PAYMENT_DISPUTE_RESOLVED', paymentId, { decision, amount: amountRupees || null, reason: note }, admin);
  await Promise.all([p.customerId, p.workerId].map((userId) => notify({ userId, type: 'DISPUTE_UPDATE', bookingId: p.bookingId, title: 'Dispute resolved', message: `An administrator resolved the dispute on your booking (${decision === 'RELEASE_TO_WORKER' ? 'decided in the professional\'s favour' : decision === 'REFUND_FULL' ? 'full refund to the customer' : 'partial refund to the customer'}).` })));
  return prisma.payment.findUnique({ where: { id: paymentId }, include: { settlement: true, refunds: true } });
};

// ── Webhooks ─────────────────────────────────────────────────────────────────

const findPaymentForEntity = async (entity) => {
  if (entity.order_id) {
    const byOrder = await prisma.payment.findUnique({ where: { gatewayOrderId: entity.order_id } });
    if (byOrder) return byOrder;
  }
  const bookingId = entity.notes && entity.notes.bookingId;
  return bookingId ? prisma.payment.findUnique({ where: { bookingId: String(bookingId) } }) : null;
};

const handlePaymentEvent = async (entity) => {
  const p = await findPaymentForEntity(entity);
  if (!p) return 'IGNORED';
  const r = await applyGatewayPayment(p.id, entity);
  if (r.staleOrder) await handleStaleOrderPayment(r.payment, entity);
  return 'PROCESSED';
};

const handleRefundEvent = async (event, refundEntity, paymentEntity) => {
  let refund = await prisma.paymentRefund.findFirst({ where: { OR: [{ gatewayRefundId: refundEntity.id }, ...(refundEntity.receipt ? [{ receipt: refundEntity.receipt }] : [])] } });
  if (!refund) {
    // Refund created outside our API (e.g. from the Razorpay dashboard): reconcile it onto the payment.
    const p = await prisma.payment.findFirst({ where: { gatewayPaymentId: refundEntity.payment_id } });
    if (!p) return 'IGNORED';
    try {
      refund = await prisma.paymentRefund.create({
        data: { paymentId: p.id, amount: pricing.fromPaise(refundEntity.amount), kind: 'DASHBOARD', reason: 'Refund issued from the Razorpay dashboard', receipt: refundEntity.receipt || `dash_${refundEntity.id}`.slice(0, 40), gatewayRefundId: refundEntity.id, gatewayPaymentId: refundEntity.payment_id }
      });
    } catch (e) { if (e.code !== 'P2002') throw e; refund = await prisma.paymentRefund.findFirst({ where: { gatewayRefundId: refundEntity.id } }); }
  } else if (!refund.gatewayRefundId) {
    await prisma.paymentRefund.update({ where: { id: refund.id }, data: { gatewayRefundId: refundEntity.id } });
  }
  if (!refund) return 'IGNORED';
  if (event === 'refund.processed' || refundEntity.status === 'processed') await finalizeRefund(refund.id);
  else if (event === 'refund.failed' || refundEntity.status === 'failed') await failRefundFromGateway(refund.id, 'Refund failed at the provider');
  return 'PROCESSED';
};

// Returns { status: 'DUPLICATE' | 'PROCESSED' | 'IGNORED' }.
const processWebhook = async ({ eventId, event, payload }) => {
  let row;
  try {
    row = await prisma.webhookEvent.create({ data: { eventId, event } });
  } catch (e) {
    if (e.code !== 'P2002') throw e;
    row = await prisma.webhookEvent.findUnique({ where: { eventId } });
    if (row.status === 'PROCESSED' || row.status === 'IGNORED') return { status: 'DUPLICATE' };
    // RECEIVED/FAILED: an earlier attempt did not finish; process it again
  }
  try {
    let outcome = 'IGNORED';
    const pay = payload && payload.payment && payload.payment.entity;
    if (['payment.authorized', 'payment.captured', 'payment.failed', 'order.paid'].includes(event) && pay) outcome = await handlePaymentEvent(pay);
    else if (event.startsWith('refund.') && payload.refund && payload.refund.entity) outcome = await handleRefundEvent(event, payload.refund.entity, pay);
    else if (['transfer.processed', 'transfer.failed'].includes(event) && payload.transfer && payload.transfer.entity) outcome = (await settlements.handleTransferEvent(event, payload.transfer.entity)) ? 'PROCESSED' : 'IGNORED';
    else if (/^(product\.route\.|account\.)/.test(event)) outcome = (await payoutAccounts.handleAccountEvent(event, payload)) ? 'PROCESSED' : 'IGNORED';
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: outcome, processedAt: new Date(), error: null } });
    return { status: outcome };
  } catch (e) {
    await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'FAILED', error: String(e.message).slice(0, 300) } }).catch(() => {});
    throw e;
  }
};

// ── Serialisation (separate shapes for customer and worker: histories never mix) ──

const serializeForCustomer = (p, extras = {}) => ({
  id: p.id, paymentNumber: p.paymentNumber, bookingId: p.bookingId, state: p.state, currency: p.currency,
  serviceAmount: num(p.serviceAmount), platformFee: num(p.platformFee), taxAmount: num(p.taxAmount), totalAmount: num(p.totalAmount),
  amountRefunded: num(p.amountRefunded), method: p.method, methodDetail: p.methodDetail,
  capturedAt: p.capturedAt, failedAt: p.failedAt, failureReason: p.state === 'FAILED' ? p.failureReason : null, disputed: p.disputed, createdAt: p.createdAt, ...extras
});

const customerHistory = async (customerId) => {
  const rows = await prisma.payment.findMany({
    where: { customerId, state: { not: 'CREATED' } }, orderBy: { createdAt: 'desc' }, take: 100,
    include: {
      booking: { select: { bookingNumber: true, problemDescription: true, serviceItem: { select: { title: true } }, worker: { select: { id: true, name: true } } } },
      refunds: { select: { amount: true, status: true, kind: true, createdAt: true, processedAt: true }, orderBy: { createdAt: 'desc' } }
    }
  });
  return rows.map((p) => serializeForCustomer(p, {
    bookingNumber: p.booking.bookingNumber, workerName: p.booking.worker.name, workerId: p.booking.worker.id,
    service: (p.booking.serviceItem && p.booking.serviceItem.title) || p.booking.problemDescription || 'Service booking',
    refundStatus: refundSummary(p), refunds: p.refunds.map((r) => ({ amount: num(r.amount), status: r.status, kind: r.kind, createdAt: r.createdAt, processedAt: r.processedAt }))
  }));
};

// The payment summary embedded in booking payloads. Each side sees only its own side of the money:
//  * customer: what they were charged, paid and refunded (no worker commission / settlement)
//  * worker:   whether the customer has paid and their own settlement (no payment method, amounts charged, gateway ids)
//  * admin:    both
// Raw Payment rows (gateway ids, failure codes, method details) are never put in booking responses.
const serializeBookingPayment = (p, role) => {
  if (!p) return null;
  const paid = CAPTURED_FAMILY.includes(p.state);
  const refundPending = Array.isArray(p.refunds) && p.refunds.some((r) => r.status === 'PENDING' && r.kind !== 'DUPLICATE_PAYMENT');
  const customerView = {
    id: p.id, paymentNumber: p.paymentNumber, state: p.state, paid, totalAmount: num(p.totalAmount), serviceAmount: num(p.serviceAmount),
    platformFee: num(p.platformFee), taxAmount: num(p.taxAmount), amountRefunded: num(p.amountRefunded), refundPending,
    disputed: p.disputed, failureReason: p.state === 'FAILED' ? p.failureReason : null
  };
  const s = p.settlement;
  const settlementView = s ? { status: s.status, netAmount: num(s.netAmount), commission: num(s.commission), refundAdjustment: num(s.refundAdjustment), failureReason: s.status === 'FAILED' ? s.failureReason : null } : null;
  if (role === 'Admin') return { ...customerView, settlement: settlementView };
  if (role === 'Worker') return { state: p.state, paid, disputed: p.disputed, refundPending, amountRefunded: num(p.amountRefunded) > 0, settlement: settlementView };
  return customerView;
};

const refundSummary = (p) => {
  const open = p.refunds.filter((r) => r.status === 'PENDING' && r.kind !== 'DUPLICATE_PAYMENT');
  if (open.length) return 'REFUND_IN_PROGRESS';
  if (p.state === 'REFUNDED') return 'REFUNDED';
  if (p.state === 'PARTIALLY_REFUNDED') return 'PARTIALLY_REFUNDED';
  return 'NONE';
};

const customerPaymentDetail = async ({ paymentId, user }) => {
  const p = await prisma.payment.findUnique({
    where: { id: String(paymentId) },
    include: {
      booking: { select: { bookingNumber: true, status: true, scheduledAt: true, timeSlot: true, problemDescription: true, serviceItem: { select: { title: true } }, worker: { select: { id: true, name: true } }, address: { select: { street: true, city: true } } } },
      refunds: { orderBy: { createdAt: 'desc' } },
      transactions: { orderBy: { createdAt: 'asc' } }
    }
  });
  // 404 (not 403) for someone else's payment: do not reveal that it exists
  if (!p || p.customerId !== user.id) fail(404, 'Payment not found.', 'NOT_FOUND');
  const customerVisible = ['ORDER_CREATED', 'CAPTURED', 'FAILED', 'REFUND_INITIATED', 'REFUND_PROCESSED', 'REFUND_FAILED', 'DUPLICATE_PAYMENT_REFUNDED', 'DISPUTE_OPENED', 'COMPLETION_CONFIRMED'];
  return serializeForCustomer(p, {
    bookingNumber: p.booking.bookingNumber, bookingStatus: p.booking.status, scheduledAt: p.booking.scheduledAt, timeSlot: p.booking.timeSlot,
    workerName: p.booking.worker.name, service: (p.booking.serviceItem && p.booking.serviceItem.title) || p.booking.problemDescription || 'Service booking',
    address: p.booking.address ? `${p.booking.address.street}, ${p.booking.address.city}` : null, refundStatus: refundSummary(p),
    refunds: p.refunds.map((r) => ({ id: r.id, amount: num(r.amount), status: r.status, kind: r.kind, reason: r.reason, createdAt: r.createdAt, processedAt: r.processedAt, failureReason: r.status === 'FAILED' ? r.failureReason : null })),
    timeline: p.transactions.filter((t) => customerVisible.includes(t.type)).map((t) => ({ type: t.type, amount: t.amount === null ? null : num(t.amount), note: t.type === 'COMPLETION_CONFIRMED' || t.type === 'ORDER_CREATED' ? null : t.note, at: t.createdAt }))
  });
};

module.exports = {
  PaymentError, serializeBookingPayment, getQuote, createOrder, verifyCheckout, syncOrder, applyGatewayPayment, issueRefund, finalizeRefund, handleBookingCancelled,
  processWebhook, resolveDispute, customerHistory, customerPaymentDetail, serializeForCustomer, evaluatePayable, isRazorpayConfigured, getRazorpayMode
};
