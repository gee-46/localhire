// Razorpay Route (linked accounts and transfers) over the REST API.
//
// STATUS: written against Razorpay's public Route documentation and exercised only against a test double.
// It has NOT been run against a live Razorpay account: Route must be enabled for the merchant by Razorpay
// (see README, "Payouts and Razorpay Route"). Every call goes through `request()` so tests can inject a fake.
const { getRazorpayCredentials, isRazorpayConfigured } = require('../config/razorpay');

const BASE_URL = 'https://api.razorpay.com';

class RouteError extends Error {
  constructor(status, code, description, raw) {
    super(description || 'Razorpay Route request failed');
    this.status = status;
    this.code = code || null;
    this.raw = raw || null;
    // The documented symptom of Route/Marketplace not being enabled is a 400/404 "requested URL was not found".
    this.routeNotEnabled = /requested url was not found|route is not enabled|marketplace feature is not enabled/i.test(description || '');
  }
}

let httpClient = null; // (method, path, body) => Promise<{ status, json }>
const setHttpClient = (fn) => { httpClient = fn; };

const defaultHttp = async (method, path, body) => {
  const { keyId, keySecret } = getRazorpayCredentials();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* empty body */ }
  return { status: res.status, json };
};

const isAvailable = () => Boolean(httpClient) || isRazorpayConfigured();

const request = async (method, path, body) => {
  if (!isAvailable()) throw new RouteError(503, 'NOT_CONFIGURED', 'Razorpay API keys are not configured.');
  const { status, json } = await (httpClient || defaultHttp)(method, path, body);
  if (status >= 200 && status < 300) return json;
  const err = (json && json.error) || {};
  throw new RouteError(status, err.code, err.description || (json && json.message) || `HTTP ${status}`, json);
};

module.exports = {
  RouteError,
  setHttpClient,
  isAvailable,
  request,
  createLinkedAccount: (body) => request('POST', '/v2/accounts', body),
  createStakeholder: (accountId, body) => request('POST', `/v2/accounts/${encodeURIComponent(accountId)}/stakeholders`, body),
  requestProduct: (accountId, body) => request('POST', `/v2/accounts/${encodeURIComponent(accountId)}/products`, body),
  updateProduct: (accountId, productId, body) => request('PATCH', `/v2/accounts/${encodeURIComponent(accountId)}/products/${encodeURIComponent(productId)}`, body),
  fetchProduct: (accountId, productId) => request('GET', `/v2/accounts/${encodeURIComponent(accountId)}/products/${encodeURIComponent(productId)}`),
  createTransfer: (paymentId, transfers) => request('POST', `/v1/payments/${encodeURIComponent(paymentId)}/transfers`, { transfers }),
  listPaymentTransfers: (paymentId) => request('GET', `/v1/payments/${encodeURIComponent(paymentId)}/transfers`),
  fetchTransfer: (transferId) => request('GET', `/v1/transfers/${encodeURIComponent(transferId)}`),
  setTransferHold: (transferId, onHold) => request('PATCH', `/v1/transfers/${encodeURIComponent(transferId)}`, { on_hold: Boolean(onHold) }),
  reverseTransfer: (transferId, amountPaise, notes) => request('POST', `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountPaise, notes })
};
