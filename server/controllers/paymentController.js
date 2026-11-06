// HTTP layer for payments. Thin by design: authorisation lives here, every rule lives in services/*.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const { PaymentError } = require('../services/paymentCore');
const payments = require('../services/paymentService');
const settlements = require('../services/settlementService');
const payoutAccounts = require('../services/payoutAccountService');
const route = require('../services/routeClient');
const { getRazorpayCredentials, isRazorpayConfigured, getRazorpayMode, verifyWebhookSignature } = require('../config/razorpay');

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof PaymentError) {
      return res.status(e.status).json({ success: false, message: e.message, code: e.code, ...(e.extra || {}) });
    }
    console.error('[Payment Controller]', e);
    return res.status(500).json({ success: false, message: 'Server error while processing the payment request.' });
  }
};

const uid = (req) => req.user.id || (req.user._id && req.user._id.toString());
const actor = (req) => ({ id: uid(req), role: req.user.role, email: req.user.email });

// ── Public ───────────────────────────────────────────────────────────────────

// Only the PUBLIC key id is ever returned. The secret never leaves the server.
exports.getConfig = (req, res) => {
  const { keyId } = getRazorpayCredentials();
  res.json({ success: true, isConfigured: isRazorpayConfigured(), mode: getRazorpayMode(), keyId: isRazorpayConfigured() ? keyId : null, currency: 'INR' });
};

// ── Customer ─────────────────────────────────────────────────────────────────

exports.quote = handle(async (req, res) => {
  res.json({ success: true, ...(await payments.getQuote({ bookingId: req.params.bookingId, user: { id: uid(req) } })) });
});

exports.createOrder = handle(async (req, res) => {
  const order = await payments.createOrder({ bookingId: req.params.bookingId, user: { id: uid(req) } });
  res.status(order.reused ? 200 : 201).json({ success: true, ...order });
});

exports.verify = handle(async (req, res) => {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
  if (!paymentId || !signature) return res.status(400).json({ success: false, message: 'razorpay_payment_id and razorpay_signature are required.' });
  const out = await payments.verifyCheckout({ bookingId: req.params.bookingId, orderId, paymentId, signature, user: { id: uid(req) } });
  res.status(out.pending ? 202 : 200).json({ success: true, ...out });
});

exports.sync = handle(async (req, res) => {
  res.json({ success: true, ...(await payments.syncOrder({ bookingId: req.params.bookingId, user: { id: uid(req) } })) });
});

exports.history = handle(async (req, res) => {
  res.json({ success: true, payments: await payments.customerHistory(uid(req)) });
});

exports.detail = handle(async (req, res) => {
  res.json({ success: true, payment: await payments.customerPaymentDetail({ paymentId: req.params.paymentId, user: { id: uid(req) } }) });
});

exports.confirmCompletion = handle(async (req, res) => {
  const out = await settlements.confirmCompletion({ bookingId: req.params.bookingId, user: { id: uid(req), role: req.user.role } });
  res.json({
    success: true, message: out.payout.dispatched ? 'Thank you. The professional\'s payout is being processed.' : 'Thank you. The service is confirmed complete.',
    booking: { id: out.booking.id, status: out.booking.status }, payoutDispatched: Boolean(out.payout.dispatched)
  });
});

// Any party to the booking (or an admin) can open a dispute; payment is put on hold.
exports.dispute = handle(async (req, res) => {
  const out = await settlements.openDispute({ bookingId: req.params.bookingId, user: { id: uid(req), role: req.user.role }, reason: req.body && req.body.reason });
  res.json({ success: true, message: 'Dispute opened. The payment is on hold while an administrator reviews it.', ticketId: out.ticketId });
});

// ── Razorpay webhook (signature-verified, idempotent) ────────────────────────

exports.webhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.status(400).json({ success: false, message: 'Missing x-razorpay-signature header' });
    if (!getRazorpayCredentials().webhookSecret) return res.status(503).json({ success: false, message: 'Webhook secret is not configured on the server.' });
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!verifyWebhookSignature({ rawBody: raw, signature })) {
      console.warn('[Razorpay Webhook] invalid signature rejected');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }
    const body = req.body || {};
    if (!body.event || !body.payload) return res.status(400).json({ success: false, message: 'Invalid webhook payload' });
    const eventId = req.headers['x-razorpay-event-id'] || `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
    const result = await payments.processWebhook({ eventId: String(eventId), event: String(body.event), payload: body.payload });
    return res.json({ status: 'ok', result: result.status });
  } catch (e) {
    console.error('[Razorpay Webhook] processing error:', e);
    // 5xx makes Razorpay retry the delivery
    return res.status(500).json({ success: false, message: 'Webhook processing error' });
  }
};

// ── Worker: earnings + payout account ────────────────────────────────────────

exports.workerEarnings = handle(async (req, res) => {
  res.json({ success: true, ...(await settlements.getEarnings(uid(req))) });
});

exports.payoutAccountStatus = handle(async (req, res) => {
  res.json({ success: true, ...(await payoutAccounts.getStatus(uid(req))) });
});

exports.payoutAccountStart = handle(async (req, res) => {
  const account = await payoutAccounts.startOnboarding({ user: { id: uid(req), role: req.user.role }, details: req.body });
  res.status(202).json({ success: true, account });
});

exports.payoutAccountSync = handle(async (req, res) => {
  res.json({ success: true, account: await payoutAccounts.sync(uid(req)) });
});

// ── Admin ────────────────────────────────────────────────────────────────────

exports.adminList = handle(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 15));
  const state = String(req.query.state || '').toUpperCase();
  const where = {
    ...(['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(state) ? { state } : {}),
    ...(req.query.disputed === 'true' ? { disputed: true } : {}),
    ...(req.query.q ? { OR: [{ paymentNumber: { contains: String(req.query.q), mode: 'insensitive' } }, { booking: { bookingNumber: { contains: String(req.query.q), mode: 'insensitive' } } }] } : {})
  };
  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit,
      include: {
        booking: { select: { bookingNumber: true } }, customer: { select: { name: true } }, worker: { select: { name: true } },
        settlement: { select: { id: true, status: true, netAmount: true, failureReason: true } }, refunds: { select: { amount: true, status: true } }
      }
    })
  ]);
  res.json({
    success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)),
    payments: rows.map((p) => ({
      id: p.id, paymentNumber: p.paymentNumber, bookingNumber: p.booking.bookingNumber, customer: p.customer.name, worker: p.worker.name, state: p.state,
      totalAmount: Number(p.totalAmount), amountRefunded: Number(p.amountRefunded), method: p.methodDetail || p.method, disputed: p.disputed, capturedAt: p.capturedAt, createdAt: p.createdAt,
      settlement: p.settlement ? { id: p.settlement.id, status: p.settlement.status, netAmount: Number(p.settlement.netAmount), failureReason: p.settlement.failureReason } : null,
      pendingRefund: p.refunds.some((r) => r.status === 'PENDING')
    }))
  });
});

exports.adminRefund = handle(async (req, res) => {
  const amount = req.body && req.body.amount !== undefined && req.body.amount !== '' ? Number(req.body.amount) : null;
  if (amount !== null && !Number.isFinite(amount)) return res.status(400).json({ success: false, message: 'Refund amount must be a number.' });
  const refund = await payments.issueRefund({ paymentId: req.params.paymentId, amountRupees: amount, kind: 'ADMIN', reason: (req.body && req.body.reason) || 'Refund issued by an administrator', actor: actor(req) });
  res.json({ success: true, refund: { id: refund.id, amount: Number(refund.amount), status: refund.status } });
});

exports.adminResolveDispute = handle(async (req, res) => {
  const p = await payments.resolveDispute({ paymentId: req.params.paymentId, decision: req.body && req.body.decision, amountRupees: req.body && req.body.amount, reason: req.body && req.body.reason, admin: actor(req) });
  res.json({ success: true, state: p.state, settlement: p.settlement ? p.settlement.status : null });
});

exports.adminRetryPayout = handle(async (req, res) => {
  const result = await settlements.retryPayout(req.params.settlementId, actor(req));
  res.json({ success: true, result });
});

exports.adminPayoutStatus = handle(async (req, res) => {
  res.json({
    success: true, ...payoutAccounts.availability(), razorpayConfigured: isRazorpayConfigured(), razorpayMode: getRazorpayMode(),
    webhookSecretConfigured: Boolean(getRazorpayCredentials().webhookSecret), routeClientAvailable: route.isAvailable(),
    note: 'Whether Razorpay Route is enabled for this merchant can only be confirmed by Razorpay. Run "npm --prefix server run razorpay:route-check" with your keys.'
  });
});
