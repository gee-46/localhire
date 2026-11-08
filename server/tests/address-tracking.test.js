const test = require('node:test');
const assert = require('node:assert/strict');

const addressController = require('../controllers/addressController');

function createMockResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
    send(data) {
      this.payload = data;
      return this;
    }
  };
}

test('customer addresses reject invalid geocoordinates', async () => {
  const req = {
    user: { id: 'customer-1', role: 'Customer' },
    body: {
      label: 'Home',
      street: '3 Main Street',
      city: 'Bengaluru',
      postalCode: '560001',
      latitude: 100,
      longitude: 20
    }
  };

  const res = createMockResponse();

  await addressController.createAddress(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.success, false);
  assert.match(String(res.payload.message).toLowerCase(), /latitude|longitude|valid/i);
});

// Booking tracking authorization is covered with real sockets and a real database in tests/tracking.test.js.
