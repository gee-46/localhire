// Server-side money maths. The browser never supplies an amount: everything payable is derived here from the
// booking's confirmed price and the platform's configured rates. All arithmetic is done in integer paise.
//
// Env (platform fee, fee tax and cancellation fee default to 0, so nothing extra is charged that you have not configured;
// the worker commission defaults to 10%, LocalHire's standard rate):
//   PLATFORM_FEE_PERCENT         added on top of the service amount, paid by the customer
//   PLATFORM_FEE_TAX_PERCENT     tax (e.g. GST) charged on that platform fee, paid by the customer
//   WORKER_COMMISSION_PERCENT    deducted from the worker's service amount
//   CUSTOMER_CANCELLATION_FEE_PERCENT  share of the service amount kept when a customer cancels after the worker is on the way
const percentEnv = (name, fallback = 0) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : fallback;
};

const getRates = () => ({
  platformFeePercent: percentEnv('PLATFORM_FEE_PERCENT'),
  platformFeeTaxPercent: percentEnv('PLATFORM_FEE_TAX_PERCENT'),
  workerCommissionPercent: percentEnv('WORKER_COMMISSION_PERCENT', 10),
  customerCancellationFeePercent: percentEnv('CUSTOMER_CANCELLATION_FEE_PERCENT')
});

const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => Math.round(Number(paise)) / 100;
const pctOf = (paise, percent) => Math.round((paise * percent) / 100);

// Breakdown for one booking, in paise.
const computeBreakdown = (serviceRupees, rates = getRates()) => {
  const servicePaise = toPaise(serviceRupees);
  if (!Number.isInteger(servicePaise) || servicePaise <= 0) throw Object.assign(new Error('Invalid service amount'), { status: 400 });
  const platformFeePaise = pctOf(servicePaise, rates.platformFeePercent);
  const taxPaise = pctOf(platformFeePaise, rates.platformFeeTaxPercent);
  const totalPaise = servicePaise + platformFeePaise + taxPaise;
  const commissionPaise = pctOf(servicePaise, rates.workerCommissionPercent);
  return {
    servicePaise, platformFeePaise, taxPaise, totalPaise, commissionPaise,
    workerNetPaise: servicePaise - commissionPaise,
    rates
  };
};

// Rupee view for API responses / DB columns.
const breakdownRupees = (b) => ({
  serviceAmount: fromPaise(b.servicePaise),
  platformFee: fromPaise(b.platformFeePaise),
  taxAmount: fromPaise(b.taxPaise),
  totalAmount: fromPaise(b.totalPaise)
});

// Worker-side figures after refunds. A refund is applied to the service amount first (the fee and tax come back
// only once the service amount is fully refunded); the platform returns its commission on the refunded share.
//
// `serviceRefundedRupees` may be given when the caller already knows how much of the refunds hit the service amount
// (see serviceRefundedFor); otherwise the service-first rule is applied to `amountRefundedRupees`.
const settlementAfterRefunds = ({ serviceRupees, commissionRatePercent, amountRefundedRupees, serviceRefundedRupees }) => {
  const servicePaise = toPaise(serviceRupees);
  const refundedPaise = toPaise(amountRefundedRupees);
  const originalCommission = pctOf(servicePaise, commissionRatePercent);
  const originalNet = servicePaise - originalCommission;
  const serviceRefunded = Math.min(serviceRefundedRupees === undefined ? refundedPaise : toPaise(serviceRefundedRupees), servicePaise);
  const remainingService = servicePaise - serviceRefunded;
  const commission = pctOf(remainingService, commissionRatePercent);
  const net = remainingService - commission;
  return {
    commission: fromPaise(commission),
    netAmount: fromPaise(net),
    refundAdjustment: fromPaise(originalNet - net)
  };
};

// How much of a set of refunds [{amount, kind}] (oldest first) reduces the SERVICE amount.
//  * Normal refunds (admin, dispute, worker cancellation) hit the service amount first: the worker bears them.
//  * A customer-cancellation refund is "everything except the cancellation fee": it returns the platform fee and
//    tax first, so the fee the customer forfeits stays with the worker's service amount.
const serviceRefundedFor = ({ serviceRupees, platformFeeRupees, taxRupees, refunds }) => {
  let feePool = toPaise(platformFeeRupees) + toPaise(taxRupees);
  let service = 0;
  for (const r of refunds) {
    const amt = toPaise(r.amount);
    if (r.kind === 'CUSTOMER_CANCELLATION') {
      const fromFees = Math.min(amt, feePool);
      feePool -= fromFees;
      service += amt - fromFees;
    } else {
      service += amt;
    }
  }
  return fromPaise(Math.min(service, toPaise(serviceRupees)));
};

module.exports = { serviceRefundedFor, getRates, toPaise, fromPaise, pctOf, computeBreakdown, breakdownRupees, settlementAfterRefunds };
