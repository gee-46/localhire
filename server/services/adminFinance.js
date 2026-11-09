// Admin financial reporting. Every figure is derived from the payment, refund and settlement RECORDS; nothing is
// "customer payments added up and called revenue".
//
// Method (cohort view): the payments that were CAPTURED in the selected period, with everything that has happened to
// them since (refunds, settlement status). For each payment, amounts split into:
//   service amount   -> belongs to the worker, minus LocalHire's commission
//   platform fee     -> LocalHire revenue (once the job is customer-confirmed)
//   tax on the fee   -> held for remittance to the tax authority; NEVER LocalHire revenue
// Refunds reduce the service amount first (a customer-cancellation refund returns fee and tax first), exactly as the
// settlement does (pricing.serviceRefundedFor), so the books reconcile to the paisa:
//   net cash received = worker net entitlement + commission + platform fees net + taxes net
// Money is handled in integer paise.
const prisma = require('../config/prisma');
const pricing = require('./pricing');
const { payoutMode } = require('./paymentCore');
const { dateWhere } = require('./adminRange');

const EARNED = ['ELIGIBLE', 'PAYOUT_PROCESSING', 'PAID', 'FAILED'];   // the customer confirmed the job
const HELD = ['PENDING_COMPLETION', 'BLOCKED'];                        // paid, not yet confirmed / disputed
const OUTSTANDING = ['PENDING_COMPLETION', 'BLOCKED', 'ELIGIBLE', 'PAYOUT_PROCESSING', 'FAILED'];

const P = (v) => pricing.toPaise(Number(v || 0));
const R = (paise) => pricing.fromPaise(paise);
const zero = () => ({ paise: 0, count: 0 });

const summarise = async (range) => {
  const capturedAt = dateWhere(range);
  const payments = await prisma.payment.findMany({
    where: { capturedAt: capturedAt || { not: null } },
    select: {
      id: true, totalAmount: true, serviceAmount: true, platformFee: true, taxAmount: true, amountRefunded: true, gatewayFee: true, gatewayFeeTax: true, state: true, disputed: true,
      refunds: { where: { status: 'PROCESSED', kind: { not: 'DUPLICATE_PAYMENT' } }, orderBy: { createdAt: 'asc' }, select: { amount: true, kind: true } },
      settlement: { select: { status: true, commission: true, netAmount: true, serviceAmount: true } }
    }
  });

  const t = {
    customerPayments: 0, refunds: 0, serviceGross: 0, serviceRefunded: 0, feesCollected: 0, feesRefunded: 0, taxCollected: 0, taxRefunded: 0,
    commissionEarned: 0, commissionPending: 0, feesEarned: 0, feesPending: 0, workerNetTotal: 0, commissionAll: 0,
    gatewayFee: 0, gatewayFeeReported: 0, gatewayFeeUnreported: 0
  };
  const byStatus = {};
  for (const s of ['PENDING_COMPLETION', 'BLOCKED', 'ELIGIBLE', 'PAYOUT_PROCESSING', 'PAID', 'FAILED', 'REVERSED', 'CANCELLED']) byStatus[s] = zero();
  let noSettlement = 0;

  for (const p of payments) {
    const total = P(p.totalAmount); const service = P(p.serviceAmount); const fee = P(p.platformFee); const tax = P(p.taxAmount);
    const refunded = P(p.amountRefunded);
    const serviceRefunded = Math.min(P(pricing.serviceRefundedFor({ serviceRupees: Number(p.serviceAmount), platformFeeRupees: Number(p.platformFee), taxRupees: Number(p.taxAmount), refunds: p.refunds })), service);
    const feeTaxRefunded = Math.max(0, refunded - serviceRefunded);
    const feeRefunded = fee + tax > 0 ? Math.round((feeTaxRefunded * fee) / (fee + tax)) : 0;
    const taxRefunded = feeTaxRefunded - feeRefunded;
    const feeNet = fee - feeRefunded;

    t.customerPayments += total; t.refunds += refunded; t.serviceGross += service; t.serviceRefunded += serviceRefunded;
    t.feesCollected += fee; t.feesRefunded += feeRefunded; t.taxCollected += tax; t.taxRefunded += taxRefunded;
    if (p.gatewayFee !== null) { t.gatewayFee += P(p.gatewayFee) + P(p.gatewayFeeTax); t.gatewayFeeReported += 1; } else t.gatewayFeeUnreported += 1;

    const s = p.settlement;
    if (!s) { noSettlement += 1; continue; }
    const commission = P(s.commission); const net = P(s.netAmount);
    t.workerNetTotal += net; t.commissionAll += commission;
    if (byStatus[s.status]) { byStatus[s.status].paise += net; byStatus[s.status].count += 1; }
    if (EARNED.includes(s.status)) { t.commissionEarned += commission; t.feesEarned += feeNet; } else if (HELD.includes(s.status)) { t.commissionPending += commission; t.feesPending += feeNet; }
  }

  const netCash = t.customerPayments - t.refunds;
  const taxNet = t.taxCollected - t.taxRefunded;
  const feesNet = t.feesCollected - t.feesRefunded;
  const reconciled = t.workerNetTotal + t.commissionAll + feesNet + taxNet;
  const outstanding = OUTSTANDING.reduce((a, k) => a + byStatus[k].paise, 0);
  const rates = pricing.getRates();
  const mode = payoutMode();

  return {
    period: { from: range.fromYmd, to: range.toYmd },
    basis: 'Payments captured in the period, with all refunds and settlement progress recorded for them so far.',
    paymentsCount: payments.length,
    // Money in and out
    customerPaymentValue: R(t.customerPayments),         // everything customers were charged (service + fees + tax)
    refunds: R(t.refunds),                                // refunds Razorpay has processed
    netCashReceived: R(netCash),                          // customer payments minus refunds (before Razorpay's own fees)
    // What the money is made of
    grossServiceValue: R(t.serviceGross),                 // the professionals' service prices
    serviceValueRefunded: R(t.serviceRefunded),
    netServiceValue: R(t.serviceGross - t.serviceRefunded),
    platformFeesCollected: R(t.feesCollected), platformFeesRefunded: R(t.feesRefunded), platformFeesNet: R(feesNet),
    taxesCollected: R(t.taxCollected), taxesRefunded: R(t.taxRefunded), taxesNet: R(taxNet),
    taxNote: 'Tax on the platform fee is collected for the tax authority. It is not LocalHire revenue.',
    // LocalHire's own money
    commission: {
      configuredRatePercent: rates.workerCommissionPercent,
      earned: R(t.commissionEarned),                       // on jobs the customer confirmed, after refunds
      pending: R(t.commissionPending),                     // on paid jobs not yet confirmed (or in dispute): NOT yet earned
      expectedTotal: R(t.commissionEarned + t.commissionPending)
    },
    platformFeeRevenue: { earned: R(t.feesEarned), pending: R(t.feesPending) },
    localhireRevenueEarned: R(t.commissionEarned + t.feesEarned),
    localhireRevenuePending: R(t.commissionPending + t.feesPending),
    // What is owed to / paid to professionals
    workers: {
      netEntitlementTotal: R(t.workerNetTotal),
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, { amount: R(v.paise), count: v.count }])),
      outstandingLiability: R(outstanding),                // not yet paid: pending + on hold + owed + processing + failed
      owedNotYetTransferred: R(byStatus.ELIGIBLE.paise),   // confirmed jobs waiting for a payout
      actualPayoutsCompleted: R(byStatus.PAID.paise),      // the payment provider reported these as settled
      actualPayoutsCount: byStatus.PAID.count,
      failedPayouts: R(byStatus.FAILED.paise), failedPayoutsCount: byStatus.FAILED.count
    },
    gatewayFees: {
      reported: R(t.gatewayFee), paymentsReported: t.gatewayFeeReported, paymentsNotReported: t.gatewayFeeUnreported,
      note: 'Razorpay\'s own charges (including tax on them) as reported on the payments; payments where Razorpay has not reported a fee are not estimated.'
    },
    cash: {
      netCashReceived: R(netCash),
      paidOutToWorkers: R(byStatus.PAID.paise),
      stillHeldByLocalHire: R(netCash - byStatus.PAID.paise),
      note: 'Money received from customers less refunds less payouts already completed. It covers the outstanding worker liability, LocalHire revenue (earned and pending), and taxes held.'
    },
    reconciliation: {
      netCashReceived: R(netCash),
      workerNetEntitlement: R(t.workerNetTotal), commission: R(t.commissionAll), platformFeesNet: R(feesNet), taxesNet: R(taxNet),
      accountedFor: R(reconciled), difference: R(netCash - reconciled), paymentsWithoutSettlement: noSettlement
    },
    payouts: {
      mode,
      railActive: mode === 'ROUTE',
      note: mode === 'ROUTE'
        ? 'Payouts go through Razorpay Route linked accounts. A settlement is "paid" only when Razorpay reports it settled.'
        : 'Razorpay Route is not enabled (LEDGER_ONLY). Worker earnings are recorded as owed but NO money has been or will be transferred automatically: settlements need an external, approved payout process. "Owed" amounts are liabilities, not payments.'
    }
  };
};

// Who is owed money (per professional), for the external payout process in LEDGER_ONLY mode.
const owedWorkers = async ({ limit = 50 } = {}) => {
  const groups = await prisma.workerSettlement.groupBy({ by: ['workerId', 'status'], where: { status: { in: ['ELIGIBLE', 'PAYOUT_PROCESSING', 'FAILED'] } }, _sum: { netAmount: true }, _count: { id: true } });
  const byWorker = new Map();
  for (const g of groups) {
    const row = byWorker.get(g.workerId) || { workerId: g.workerId, owed: 0, processing: 0, failed: 0, jobs: 0 };
    const amt = P(g._sum.netAmount);
    if (g.status === 'ELIGIBLE') row.owed += amt; else if (g.status === 'PAYOUT_PROCESSING') row.processing += amt; else row.failed += amt;
    row.jobs += g._count.id;
    byWorker.set(g.workerId, row);
  }
  const rows = [...byWorker.values()].sort((a, b) => (b.owed + b.processing + b.failed) - (a.owed + a.processing + a.failed)).slice(0, Math.min(200, limit));
  const users = rows.length ? await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.workerId) } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ workerId: r.workerId, name: names.get(r.workerId) || 'Worker', owed: R(r.owed), processing: R(r.processing), failed: R(r.failed), total: R(r.owed + r.processing + r.failed), jobs: r.jobs }));
};

const SETTLEMENT_STATUSES = ['PENDING_COMPLETION', 'ELIGIBLE', 'PAYOUT_PROCESSING', 'PAID', 'FAILED', 'REVERSED', 'BLOCKED', 'CANCELLED'];

const listSettlements = async ({ status, page = 1, limit = 15, range }) => {
  const where = {
    ...(SETTLEMENT_STATUSES.includes(String(status || '').toUpperCase()) ? { status: String(status).toUpperCase() } : {}),
    ...(range && dateWhere(range) ? { createdAt: dateWhere(range) } : {})
  };
  const take = Math.min(50, Math.max(1, Number(limit) || 15)); const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const [total, rows] = await Promise.all([
    prisma.workerSettlement.count({ where }),
    prisma.workerSettlement.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { payment: { select: { paymentNumber: true } } } })
  ]);
  const [workers, bookings] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.workerId))] } }, select: { id: true, name: true } }),
    prisma.booking.findMany({ where: { id: { in: rows.map((r) => r.bookingId) } }, select: { id: true, bookingNumber: true } })
  ]);
  const wn = new Map(workers.map((w) => [w.id, w.name])); const bn = new Map(bookings.map((b) => [b.id, b.bookingNumber]));
  return {
    total, page: Math.max(1, Number(page) || 1), pages: Math.max(1, Math.ceil(total / take)),
    settlements: rows.map((r) => ({
      id: r.id, paymentNumber: r.payment.paymentNumber, bookingNumber: bn.get(r.bookingId) || null, worker: wn.get(r.workerId) || 'Worker',
      serviceAmount: Number(r.serviceAmount), commission: Number(r.commission), refundAdjustment: Number(r.refundAdjustment), netAmount: Number(r.netAmount),
      status: r.status, payoutRail: r.payoutRail, failureReason: r.status === 'FAILED' ? r.failureReason : null, eligibleAt: r.eligibleAt, paidAt: r.paidAt, createdAt: r.createdAt
    }))
  };
};

module.exports = { summarise, owedWorkers, listSettlements, SETTLEMENT_STATUSES, EARNED, HELD, OUTSTANDING };
