const test = require('node:test');
const assert = require('node:assert/strict');

const notificationController = require('../controllers/notificationController');

test('the gateway is reported unavailable (never simulated) when Razorpay keys are missing', () => {
  const original = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET };
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  const cfg = require('../config/razorpay');
  cfg.setRazorpayInstance(null);
  try {
    assert.equal(cfg.isRazorpayConfigured(), false);
    assert.equal(cfg.getRazorpayInstance(), null);
    assert.equal(cfg.getRazorpayMode(), null);
    assert.equal(typeof cfg.isSimulationAllowed, 'undefined', 'there is no simulation switch any more');
  } finally {
    if (original.id) process.env.RAZORPAY_KEY_ID = original.id;
    if (original.secret) process.env.RAZORPAY_KEY_SECRET = original.secret;
  }
});

test('booking notification payloads must include user, type, title, and message metadata', () => {
  const payload = notificationController.buildNotificationPayload({
    userId: 'user-1',
    type: 'BOOKING_REQUEST',
    title: 'Booking request received',
    message: 'A customer requested a booking for your service.'
  });

  assert.equal(payload.userId, 'user-1');
  assert.equal(payload.type, 'BOOKING_REQUEST');
  assert.equal(payload.title, 'Booking request received');
  assert.match(payload.message, /customer requested a booking/i);
});
