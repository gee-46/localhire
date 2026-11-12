// LocalHire - Razorpay configuration and cryptographic helpers.
// Secrets are read from the server environment only and are never sent to a browser. The only value exposed to
// the frontend is the public key id. There is no simulated gateway: development uses Razorpay TEST mode keys.

const Razorpay = require('razorpay');
const crypto = require('crypto');

const getRazorpayCredentials = () => ({
  keyId: process.env.RAZORPAY_KEY_ID || null,
  keySecret: process.env.RAZORPAY_KEY_SECRET || null,
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null
});

const isPlaceholder = (v) => !v || v.includes('replace_with') || v.includes('your_');

const isRazorpayConfigured = () => {
  const { keyId, keySecret } = getRazorpayCredentials();
  return !isPlaceholder(keyId) && !isPlaceholder(keySecret);
};

// 'test' (rzp_test_...) or 'live' (rzp_live_...); null when not configured.
const getRazorpayMode = () => {
  const { keyId } = getRazorpayCredentials();
  if (isPlaceholder(keyId)) return null;
  return keyId.startsWith('rzp_live_') ? 'live' : 'test';
};

let razorpayInstance = null;

const getRazorpayInstance = () => {
  if (razorpayInstance) return razorpayInstance;
  if (!isRazorpayConfigured()) return null;
  const { keyId, keySecret } = getRazorpayCredentials();
  razorpayInstance = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return razorpayInstance;
};

// Test hook: inject a fake gateway (or null to reset).
const setRazorpayInstance = (instance) => {
  razorpayInstance = instance;
};

// Constant-time string comparison to prevent timing attacks
const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

// Checkout success signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret).
// `orderId` must be the order id stored on the SERVER, never the one echoed by the browser.
const verifyPaymentSignature = ({ orderId, paymentId, signature }) => {
  if (!orderId || !paymentId || !signature) return false;
  const { keySecret } = getRazorpayCredentials();
  if (!keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeCompare(expected, signature);
};

// Webhook signature: HMAC-SHA256(raw request body, webhook secret). The body must be the exact bytes received.
const verifyWebhookSignature = ({ rawBody, signature }) => {
  if (!rawBody || !signature) return false;
  const { webhookSecret } = getRazorpayCredentials();
  if (!webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return safeCompare(expected, signature);
};

module.exports = {
  getRazorpayCredentials,
  isRazorpayConfigured,
  getRazorpayMode,
  getRazorpayInstance,
  setRazorpayInstance,
  verifyPaymentSignature,
  verifyWebhookSignature,
  safeCompare
};
