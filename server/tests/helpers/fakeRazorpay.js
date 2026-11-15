// An in-memory stand-in for the Razorpay REST API, injected with setRazorpayInstance().
//
// It exists so payment logic can be tested without network access or real money. It models only the parts of
// Razorpay that LocalHire calls (orders, payments, refunds), with the same response shapes. Signatures in the
// tests are computed with the real HMAC algorithm and the same secrets the server uses - nothing about the
// signature checks is mocked.
const crypto = require('crypto');

class FakeRazorpay {
  constructor() {
    this.reset();
    const self = this;
    this.orders = {
      create: async (params) => {
        self.calls.push(['orders.create', params]);
        if (self.failOrderCreate) throw { statusCode: 500, error: { description: 'gateway down' } };
        const id = `order_${++self.seq}`;
        const order = { id, amount: params.amount, currency: params.currency, receipt: params.receipt, notes: params.notes || {}, status: 'created' };
        self.orderStore.set(id, order);
        return { ...order };
      },
      fetchPayments: async (orderId) => {
        self.calls.push(['orders.fetchPayments', orderId]);
        if (self.failFetch) throw new Error('gateway unreachable');
        return { items: [...self.paymentStore.values()].filter((p) => p.order_id === orderId).map((p) => ({ ...p })) };
      }
    };
    this.payments = {
      fetch: async (id) => {
        self.calls.push(['payments.fetch', id]);
        if (self.failFetch) throw new Error('gateway unreachable');
        const p = self.paymentStore.get(id);
        if (!p) throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
        return { ...p };
      },
      capture: async (id, amount) => {
        self.calls.push(['payments.capture', id, amount]);
        const p = self.paymentStore.get(id);
        if (!p || p.status !== 'authorized') throw { statusCode: 400, error: { description: 'This payment cannot be captured' } };
        if (amount !== p.amount) throw { statusCode: 400, error: { description: 'Capture amount must equal the authorized amount' } };
        p.status = 'captured';
        p.captured = true;
        return { ...p };
      },
      refund: async (id, params) => {
        self.calls.push(['payments.refund', id, params]);
        if (self.failRefund) throw { statusCode: 400, error: { description: 'Refund rejected by the bank' } };
        const p = self.paymentStore.get(id);
        if (!p || !p.captured) throw { statusCode: 400, error: { description: 'The payment has not been captured' } };
        const dup = [...self.refundStore.values()].find((r) => params.receipt && r.receipt === params.receipt);
        if (dup) return { ...dup };
        const amount = params.amount === undefined ? p.amount - p.amount_refunded : params.amount;
        if (amount > p.amount - p.amount_refunded) throw { statusCode: 400, error: { description: 'The refund amount is greater than the amount available for refund' } };
        p.amount_refunded += amount;
        p.refund_status = p.amount_refunded >= p.amount ? 'full' : 'partial';
        const refund = { id: `rfnd_${++self.seq}`, entity: 'refund', payment_id: id, amount, currency: 'INR', receipt: params.receipt || null, status: self.refundStatus, notes: params.notes || {} };
        self.refundStore.set(refund.id, refund);
        return { ...refund };
      }
    };
  }

  reset() {
    // ids are never reused across tests: they are stored in the database, where they are unique
    this.seq = this.seq ? this.seq : Date.now() % 100000000;
    this.calls = [];
    this.orderStore = new Map();
    this.paymentStore = new Map();
    this.refundStore = new Map();
    this.refundStatus = 'processed';
    this.failRefund = false;
    this.failFetch = false;
    this.failOrderCreate = false;
  }

  count(name) { return this.calls.filter((c) => c[0] === name).length; }

  // Simulate the customer finishing (or failing) a payment on the Checkout page.
  pay(orderId, { status = 'captured', method = 'card', amount, fee, tax } = {}) {
    const order = this.orderStore.get(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);
    const id = `pay_${++this.seq}`;
    const entity = {
      id, entity: 'payment', order_id: orderId, amount: amount === undefined ? order.amount : amount, currency: order.currency, status,
      captured: status === 'captured', method, amount_refunded: 0, refund_status: null, notes: order.notes
    };
    if (fee !== undefined) { entity.fee = fee; entity.tax = tax === undefined ? 0 : tax; }
    if (method === 'card') entity.card = { network: 'Visa', last4: '1111' };
    if (status === 'failed') { entity.error_code = 'BAD_REQUEST_ERROR'; entity.error_description = 'Payment failed because the card was declined'; }
    this.paymentStore.set(id, entity);
    return { ...entity };
  }
}

const checkoutSignature = (secret, orderId, paymentId) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
const webhookSignature = (secret, rawBody) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

// Fake of the Route REST transport used by services/routeClient (setHttpClient).
class FakeRoute {
  constructor() { this.reset(); }
  reset() {
    this.seq = this.seq ? this.seq : 500000000 + (Date.now() % 100000000);
    this.calls = [];
    this.transfers = new Map();
    this.failTransfer = false;
    this.failHold = false;
    this.notEnabled = false;
    this.nextProductStatus = 'activated';
  }
  count(prefix) { return this.calls.filter((c) => c.startsWith(prefix)).length; }
  client() {
    return async (method, path, body) => {
      this.calls.push(`${method} ${path}`);
      const err = (status, description) => ({ status, json: { error: { code: 'BAD_REQUEST_ERROR', description } } });
      if (this.notEnabled) return err(400, 'The requested URL was not found on the server.');
      let m;
      if (method === 'POST' && path === '/v2/accounts') return { status: 200, json: { id: `acc_${++this.seq}`, status: 'created' } };
      if (method === 'POST' && /\/stakeholders$/.test(path)) return { status: 200, json: { id: `sth_${++this.seq}` } };
      if (method === 'POST' && /\/products$/.test(path)) return { status: 200, json: { id: `acc_prd_${++this.seq}`, activation_status: 'needs_clarification', requirements: [{ field_reference: 'settlements.account_number' }] } };
      if (method === 'PATCH' && /\/products\//.test(path)) return { status: 200, json: { id: path.split('/').pop(), activation_status: this.nextProductStatus, requirements: [], settlement_accounts: [{ verification_status: this.nextProductStatus === 'activated' ? 'verified' : 'pending' }] } };
      if (method === 'GET' && /\/products\//.test(path)) return { status: 200, json: { id: path.split('/').pop(), activation_status: this.nextProductStatus, requirements: [] } };
      if (method === 'POST' && (m = path.match(/^\/v1\/payments\/([^/]+)\/transfers$/))) {
        if (this.failTransfer) return err(400, 'Transfer could not be created');
        const t = body.transfers[0];
        const id = `trf_${++this.seq}`;
        const row = { id, source: m[1], recipient: t.account, amount: t.amount, currency: t.currency, notes: t.notes, on_hold: Boolean(t.on_hold), status: 'created', settlement_status: t.on_hold ? 'on_hold' : 'pending', amount_reversed: 0 };
        this.transfers.set(id, row);
        return { status: 200, json: { items: [{ ...row }] } };
      }
      if (method === 'GET' && (m = path.match(/^\/v1\/payments\/([^/]+)\/transfers$/))) {
        return { status: 200, json: { items: [...this.transfers.values()].filter((t) => t.source === m[1]).map((t) => ({ ...t })) } };
      }
      if (method === 'GET' && (m = path.match(/^\/v1\/transfers\/([^/]+)$/))) {
        const t = this.transfers.get(m[1]);
        return t ? { status: 200, json: { ...t } } : err(400, 'not found');
      }
      if (method === 'PATCH' && (m = path.match(/^\/v1\/transfers\/([^/]+)$/))) {
        if (this.failHold) return err(400, 'Hold could not be changed');
        const t = this.transfers.get(m[1]);
        if (!t) return err(400, 'not found');
        t.on_hold = Boolean(body.on_hold);
        t.settlement_status = t.on_hold ? 'on_hold' : 'pending';
        return { status: 200, json: { ...t } };
      }
      if (method === 'POST' && (m = path.match(/^\/v1\/transfers\/([^/]+)\/reversals$/))) {
        const t = this.transfers.get(m[1]);
        if (!t) return err(400, 'not found');
        t.amount_reversed += body.amount;
        return { status: 200, json: { id: `rvrsl_${++this.seq}`, transfer_id: t.id, amount: body.amount } };
      }
      return err(404, `unexpected ${method} ${path}`);
    };
  }
}

module.exports = { FakeRazorpay, FakeRoute, checkoutSignature, webhookSignature };
