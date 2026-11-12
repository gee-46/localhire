// Read-only probe: is Razorpay Route enabled for the account behind RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET?
//
//   npm --prefix server run razorpay:route-check
//
// It makes two harmless requests and never creates an account, transfer or payment:
//   1. GET  /v1/transfers?count=1   - the Route "transfers" API. If Route is not enabled for the merchant,
//                                     Razorpay answers "The requested URL was not found on the server".
//   2. POST /v2/accounts  (empty body) - the linked-accounts API. An enabled merchant gets a 400 validation error
//                                     about missing fields (nothing is created); a non-enabled one gets URL-not-found.
// A positive result means "the API is reachable for this merchant". It does NOT mean linked accounts will be
// activated, that payouts will settle, or that RBI/Razorpay marketplace requirements are satisfied.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const placeholder = (v) => !v || v.includes('replace_with') || v.includes('your_');

if (placeholder(keyId) || placeholder(keySecret)) {
  console.error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set in server/.env. Nothing was checked.');
  process.exit(2);
}

const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
const call = async (method, p, body) => {
  const res = await fetch(`https://api.razorpay.com${p}`, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, json, text: JSON.stringify(json || {}).slice(0, 300) };
};
const notFound = (r) => /requested url was not found/i.test((r.json && r.json.error && r.json.error.description) || '');

(async () => {
  console.log(`Mode: ${keyId.startsWith('rzp_live_') ? 'LIVE' : 'TEST'} keys (${keyId.slice(0, 12)}…)`);
  let transfers; let accounts;
  try {
    transfers = await call('GET', '/v1/transfers?count=1');
    accounts = await call('POST', '/v2/accounts', {});
  } catch (e) {
    console.error('Could not reach api.razorpay.com:', e.message);
    process.exit(3);
  }
  console.log(`GET  /v1/transfers  -> HTTP ${transfers.status}  ${transfers.text}`);
  console.log(`POST /v2/accounts   -> HTTP ${accounts.status}  ${accounts.text}`);

  if (transfers.status === 401 || accounts.status === 401) {
    console.log('\nRESULT: the API keys were rejected (authentication failed). Fix the keys first.');
    process.exit(4);
  }
  const off = notFound(transfers) || notFound(accounts);
  if (off) {
    console.log('\nRESULT: Route does NOT appear to be enabled for this account.');
    console.log('  Keep PAYOUT_MODE=LEDGER_ONLY. Worker earnings are recorded as owed but no payouts are made.');
    console.log('  To enable Route, request it from Razorpay (Dashboard -> Route, or your account manager) and complete their review.');
    process.exit(1);
  }
  if (transfers.status === 200 || accounts.status === 400) {
    console.log('\nRESULT: the Route APIs respond for this account.');
    console.log('  You can try PAYOUT_MODE=ROUTE in TEST mode. LocalHire\'s Route code has not been verified against live Razorpay,');
    console.log('  so test onboarding of one linked account and one transfer end-to-end before relying on it.');
    process.exit(0);
  }
  console.log('\nRESULT: inconclusive. Share the two responses above with Razorpay support.');
  process.exit(5);
})();
