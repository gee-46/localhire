// Worker payout accounts = Razorpay Route "linked accounts".
//
// STATUS: implemented from Razorpay's public documentation and tested only against a test double. It has not
// been run against a live Razorpay account, and Route must first be enabled for the merchant by Razorpay.
// Bank account numbers and PAN are forwarded to Razorpay and are NOT stored or logged here; we keep the last
// four digits of the account number, the provider ids and the provider-reported status.
const { prisma, PaymentError, fail, payoutMode, audit } = require('./paymentCore');
const route = require('./routeClient');

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;

const STATUS_MAP = {
  requested: 'CREATED', created: 'CREATED', needs_clarification: 'NEEDS_CLARIFICATION', under_review: 'UNDER_REVIEW', activated: 'ACTIVATED', suspended: 'SUSPENDED'
};
const mapStatus = (s) => STATUS_MAP[String(s || '').toLowerCase()] || 'CREATED';

const view = (acc) => (acc ? {
  status: acc.status, bankLast4: acc.bankLast4, bankVerification: acc.bankVerification, legalName: acc.legalName,
  requirements: acc.requirements || [], lastError: acc.lastError, lastSyncedAt: acc.lastSyncedAt
} : { status: 'NOT_STARTED', requirements: [] });

const availability = () => ({
  payoutMode: payoutMode(),
  routeEnabledInConfig: payoutMode() === 'ROUTE',
  providerReachable: route.isAvailable()
});

const getStatus = async (userId) => {
  const acc = await prisma.workerPayoutAccount.findUnique({ where: { userId } });
  return { ...availability(), account: view(acc) };
};

const text = (v, max) => String(v || '').replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, max);

const validate = (d = {}) => {
  const out = {
    legalName: text(d.legalName, 100), pan: text(d.pan, 10).toUpperCase(), phone: String(d.phone || '').replace(/\D/g, '').slice(-10),
    street: text(d.street, 120), city: text(d.city, 60), state: text(d.state, 60), postalCode: text(d.postalCode, 10),
    accountNumber: String(d.accountNumber || '').replace(/\s/g, ''), ifsc: text(d.ifsc, 11).toUpperCase(), beneficiaryName: text(d.beneficiaryName, 100)
  };
  const errors = {};
  if (out.legalName.length < 4) errors.legalName = 'Enter your full legal name (at least 4 characters).';
  if (!PAN_RE.test(out.pan)) errors.pan = 'Enter a valid PAN (e.g. ABCDE1234F).';
  if (out.phone.length !== 10) errors.phone = 'Enter a 10-digit mobile number.';
  if (out.street.length < 3) errors.street = 'Enter your street address.';
  if (out.city.length < 2) errors.city = 'Enter your city.';
  if (out.state.length < 2) errors.state = 'Enter your state.';
  if (!/^[0-9]{6}$/.test(out.postalCode)) errors.postalCode = 'Enter a 6-digit PIN code.';
  if (!ACCOUNT_RE.test(out.accountNumber)) errors.accountNumber = 'Enter a valid bank account number (9-18 digits).';
  if (!IFSC_RE.test(out.ifsc)) errors.ifsc = 'Enter a valid IFSC code.';
  if (out.beneficiaryName.length < 2) errors.beneficiaryName = 'Enter the account holder name.';
  return { out, errors };
};

const providerFailure = (e, step) => {
  console.error(`[PayoutAccount] ${step} failed:`, e.status, e.code, e.message);
  if (e.routeNotEnabled) {
    return new PaymentError(503, 'Razorpay Route is not enabled for this LocalHire merchant account yet, so payout accounts cannot be created. The platform owner must have Route activated by Razorpay.', 'ROUTE_NOT_ENABLED');
  }
  return new PaymentError(e.status && e.status < 500 ? 422 : 502, `Razorpay rejected the ${step}: ${e.message}`, 'PROVIDER_REJECTED');
};

const applyProduct = (product) => {
  const settlement = (product && (product.active_configuration && product.active_configuration.settlements)) || (product && product.settlements) || null;
  const accounts = (product && product.settlement_accounts) || [];
  const verification = (accounts[0] && accounts[0].verification_status) || (settlement && settlement.verification_status) || null;
  return {
    status: mapStatus(product && product.activation_status),
    requirements: (product && product.requirements) || [],
    bankVerification: verification
  };
};

// Idempotent: each step is skipped if its result is already stored, so a retry after a partial failure resumes.
const startOnboarding = async ({ user, details }) => {
  if (payoutMode() !== 'ROUTE') fail(409, 'Payout accounts are not used on this platform right now (PAYOUT_MODE is not ROUTE).', 'ROUTE_DISABLED');
  if (!route.isAvailable()) fail(503, 'Razorpay is not configured on this server.', 'GATEWAY_NOT_CONFIGURED');
  const { out, errors } = validate(details);
  if (Object.keys(errors).length) throw new PaymentError(400, 'Please check the highlighted payout details.', 'VALIDATION', { errors });

  const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true, name: true } });
  let acc = await prisma.workerPayoutAccount.findUnique({ where: { userId: user.id } });
  if (acc && acc.status === 'ACTIVATED') fail(409, 'Your payout account is already active.', 'ALREADY_ACTIVE');
  if (!acc) acc = await prisma.workerPayoutAccount.create({ data: { userId: user.id, legalName: out.legalName, bankLast4: out.accountNumber.slice(-4) } });
  const save = (data) => prisma.workerPayoutAccount.update({ where: { id: acc.id }, data: { ...data, lastSyncedAt: new Date() } }).then((a) => { acc = a; return a; });

  const address = { street1: out.street, street2: out.street, city: out.city, state: out.state, postal_code: out.postalCode, country: 'IN' };
  try {
    if (!acc.gatewayAccountId) {
      const created = await route.createLinkedAccount({
        email: dbUser.email, phone: Number(out.phone), type: 'route', reference_id: user.id, legal_business_name: out.legalName,
        business_type: 'individual', contact_name: out.legalName,
        profile: { category: process.env.ROUTE_BUSINESS_CATEGORY || 'services', subcategory: process.env.ROUTE_BUSINESS_SUBCATEGORY || 'repair_and_cleaning', addresses: { registered: address } },
        legal_info: { pan: out.pan }
      });
      await save({ gatewayAccountId: created.id, status: 'CREATED', legalName: out.legalName, bankLast4: out.accountNumber.slice(-4), lastError: null });
    }
  } catch (e) { await save({ lastError: String(e.message).slice(0, 300) }).catch(() => {}); throw providerFailure(e, 'account creation'); }

  try {
    if (!acc.gatewayProductId) {
      await route.createStakeholder(acc.gatewayAccountId, { name: out.legalName, email: dbUser.email, kyc: { pan: out.pan }, addresses: { residential: { street: out.street, city: out.city, state: out.state, postal_code: out.postalCode, country: 'IN' } } })
        .catch((e) => { if (!/more than one|already/i.test(e.message)) throw e; });
      const product = await route.requestProduct(acc.gatewayAccountId, { product_name: 'route', tnc_accepted: true });
      await save({ gatewayProductId: product.id, ...applyProduct(product) });
    }
    const updated = await route.updateProduct(acc.gatewayAccountId, acc.gatewayProductId, {
      settlements: { account_number: out.accountNumber, ifsc_code: out.ifsc, beneficiary_name: out.beneficiaryName }, tnc_accepted: true
    });
    await save({ ...applyProduct(updated), bankLast4: out.accountNumber.slice(-4), lastError: null });
  } catch (e) { await save({ lastError: String(e.message).slice(0, 300) }).catch(() => {}); throw providerFailure(e, 'payout setup'); }

  await audit('PAYOUT_ACCOUNT_SUBMITTED', acc.id, { userId: user.id, status: acc.status }, user);
  return view(acc);
};

const sync = async (userId) => {
  const acc = await prisma.workerPayoutAccount.findUnique({ where: { userId } });
  if (!acc || !acc.gatewayAccountId || !acc.gatewayProductId) return view(acc);
  try {
    const product = await route.fetchProduct(acc.gatewayAccountId, acc.gatewayProductId);
    return view(await prisma.workerPayoutAccount.update({ where: { id: acc.id }, data: { ...applyProduct(product), lastError: null, lastSyncedAt: new Date() } }));
  } catch (e) { throw providerFailure(e, 'status refresh'); }
};

// product.route.* and account.* webhooks. The exact payload paths for account.* events are unverified, so several
// candidates are checked; a periodic/explicit sync is the source of truth.
const handleAccountEvent = async (event, payload) => {
  const entity = (payload && ((payload.merchant_product && payload.merchant_product.entity) || (payload.account && payload.account.entity))) || null;
  if (!entity) return false;
  const accountIds = [entity.account_id, entity.merchant_id && `acc_${entity.merchant_id}`, entity.id].filter(Boolean);
  const acc = await prisma.workerPayoutAccount.findFirst({ where: { gatewayAccountId: { in: accountIds } } });
  if (!acc) return false;
  const suffix = event.split('.').pop();
  const status = mapStatus(entity.activation_status || suffix);
  const requirements = (entity.data && entity.data.requirements) || entity.requirements || acc.requirements || [];
  await prisma.workerPayoutAccount.update({ where: { id: acc.id }, data: { status, requirements, lastSyncedAt: new Date() } });
  await audit('PAYOUT_ACCOUNT_STATUS', acc.id, { event, status }, null);
  return true;
};

module.exports = { getStatus, startOnboarding, sync, handleAccountEvent, validate, availability, view, mapStatus };
