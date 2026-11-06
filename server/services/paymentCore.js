// Shared helpers for the payment domain: errors, row locks, the append-only ledger, gateway access.
const prisma = require('../config/prisma');
const { getRazorpayInstance } = require('../config/razorpay');
const { notifyUser } = require('../controllers/notificationController');

class PaymentError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || null;
    this.extra = extra || null;
  }
}
const fail = (status, message, code, extra) => { throw new PaymentError(status, message, code, extra); };

const gateway = () => {
  const g = getRazorpayInstance();
  if (!g) fail(503, 'The payment gateway is not configured on this server. Razorpay API keys are missing.', 'GATEWAY_NOT_CONFIGURED');
  return g;
};

// 'ROUTE' = payouts go through Razorpay Route. 'LEDGER_ONLY' (default) = earnings are recorded as owed but no
// transfer is ever attempted, simulated or reported as paid.
const payoutMode = () => ((process.env.PAYOUT_MODE || 'LEDGER_ONLY').toUpperCase() === 'ROUTE' ? 'ROUTE' : 'LEDGER_ONLY');

// Pessimistic row locks so concurrent requests/webhooks for one payment are serialised.
const lockPayment = (tx, id) => tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${id} FOR UPDATE`;
const lockBooking = (tx, id) => tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${id} FOR UPDATE`;
const lockSettlement = (tx, id) => tx.$queryRaw`SELECT "id" FROM "WorkerSettlement" WHERE "id" = ${id} FOR UPDATE`;

// Append-only ledger. The unique (paymentId, type, gatewayRef) key turns a repeated event into a no-op.
const recordTx = (tx, { paymentId, type, amount = null, gatewayRef = '', note = null, actorId = null }) =>
  tx.paymentTransaction.createMany({ data: [{ paymentId, type, amount, gatewayRef: gatewayRef || '', note, actorId }], skipDuplicates: true });

const audit = (action, entityId, details, actor) =>
  prisma.auditLog.create({
    data: { userId: actor && actor.id ? actor.id : null, action, entityType: 'PAYMENT', entityId: String(entityId), details: details || {} }
  }).catch((e) => console.error('[Payments] audit write failed:', e.message));

const notify = (args) => notifyUser(args).catch((e) => console.error('[Payments] notification failed:', e.message));

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (d) => (d === null || d === undefined ? 0 : Number(d));

// Booking states in which the worker has accepted and the price is confirmed.
const PAYABLE_BOOKING_STATUSES = ['CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'];
const CAPTURED_FAMILY = ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

module.exports = {
  prisma, PaymentError, fail, gateway, payoutMode, lockPayment, lockBooking, lockSettlement, recordTx, audit, notify,
  round2, num, PAYABLE_BOOKING_STATUSES, CAPTURED_FAMILY
};
