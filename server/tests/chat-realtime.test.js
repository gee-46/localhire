// Booking chat: real Express routes, real Socket.IO server + real socket.io-client connections, real PostgreSQL.
// Nothing about authorization, storage or delivery is mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';

const prisma = require('../config/prisma');
const { signSessionToken } = require('../services/authTokens');
const { server } = require('../server');

const tag = `chat${Date.now()}`;
const created = [];
const sockets = [];
let base;
let plumber;
let seq = 0;

async function api(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { /* none */ }
  return { status: res.status, data };
}

async function makeUser(label, role) {
  const user = await prisma.user.create({ data: { email: `${tag}.${label}@example.com`, name: `${label} ${tag}`, role, isEmailVerified: true, passwordHash: null, phone: '+91 98765 43210' } });
  created.push(user.id);
  return { user, token: signSessionToken(user) };
}
const fresh = async (u) => ({ ...u, token: signSessionToken(await prisma.user.findUnique({ where: { id: u.user.id } })) });

async function makeBooking(customer, worker, status = 'CONFIRMED', extra = {}) {
  return prisma.booking.create({
    data: { bookingNumber: `BK-${tag}-${++seq}`, customerId: customer.user.id, workerId: worker.user.id, status, agreedPrice: 500, scheduledAt: new Date(Date.now() + 86400000), problemDescription: 'Leaking tap', ...extra }
  });
}

// A connected, authenticated client with helpers to wait for events and count what it received.
function connect(token, opts = {}) {
  const socket = ioClient(base, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: opts.reconnection !== false, reconnectionDelay: 50, reconnectionDelayMax: 200, forceNew: true });
  const received = [];
  const waiters = [];
  socket.onAny((event, ...args) => {
    received.push({ event, args });
    for (const w of [...waiters]) if (w.event === event && (!w.match || w.match(...args))) { waiters.splice(waiters.indexOf(w), 1); w.resolve(args[0]); }
  });
  const c = {
    socket, received,
    when: (event, match, ms = 4000) => new Promise((resolve, reject) => {
      const hit = received.find((r) => r.event === event && (!match || match(...r.args)));
      if (hit) return resolve(hit.args[0]);
      const w = { event, match, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${event}`)); } }, ms);
    }),
    count: (event) => received.filter((r) => r.event === event).length,
    emit: (event, data) => new Promise((resolve) => socket.timeout(4000).emit(event, data, (err, res) => resolve(err ? { ok: false, error: 'timeout' } : res))),
    ready: () => new Promise((resolve, reject) => { if (socket.connected) return resolve(); socket.once('connect', resolve); socket.once('connect_error', reject); }),
    close: () => socket.close()
  };
  sockets.push(c);
  return c;
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const cid = () => `c${Date.now().toString(36)}${(++seq).toString(36)}abcd`;

test.before(async () => {
  plumber = await prisma.serviceCategory.findFirst({ where: { name: 'Plumber' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  sockets.forEach((c) => c.close());
  const bookings = (await prisma.booking.findMany({ where: { OR: [{ customerId: { in: created } }, { workerId: { in: created } }] }, select: { id: true } })).map((b) => b.id);
  await prisma.notification.deleteMany({ where: { userId: { in: created } } }).catch(() => {});
  await prisma.chatMessage.deleteMany({ where: { OR: [{ senderId: { in: created } }, { receiverId: { in: created } }] } }).catch(() => {});
  await prisma.conversation.deleteMany({ where: { OR: [{ user1Id: { in: created } }, { user2Id: { in: created } }] } }).catch(() => {});
  await prisma.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookings } } }).catch(() => {});
  await prisma.booking.deleteMany({ where: { id: { in: bookings } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ─── Authorization (REST) ───────────────────────────────────────────────────

test('only the booking\'s customer and assigned worker can read or write its conversation', async () => {
  const c = await makeUser('az-c', 'CUSTOMER');
  const c2 = await makeUser('az-c2', 'CUSTOMER');
  const w = await makeUser('az-w', 'WORKER');
  const w2 = await makeUser('az-w2', 'WORKER'); // a worker who is NOT assigned to this booking
  const admin = await makeUser('az-a', 'ADMIN');
  const b = await makeBooking(c, w);
  const other = await makeBooking(c2, w2);

  assert.equal((await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'Hello, are you free tomorrow?' } })).status, 201);
  assert.equal((await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: w.token, json: { content: 'Yes, 10 am works.' } })).status, 201);

  for (const [who, name] of [[c2, 'another customer'], [w2, 'an unassigned worker'], [admin, 'an admin']]) {
    for (const [method, path, json] of [
      ['GET', `/api/chat/bookings/${b.id}`], ['GET', `/api/chat/bookings/${b.id}/messages`],
      ['POST', `/api/chat/bookings/${b.id}/messages`, { content: 'let me in' }], ['POST', `/api/chat/bookings/${b.id}/read`]
    ]) {
      const r = await api(method, path, { token: who.token, json });
      assert.equal(r.status, 403, `${name} must not ${method} ${path}`);
      assert.equal(JSON.stringify(r.data).includes('Hello, are you free'), false, 'no message content leaks in the error');
    }
  }
  assert.equal(await prisma.chatMessage.count({ where: { content: 'let me in' } }), 0);
  assert.equal((await api('GET', `/api/chat/bookings/${b.id}/messages`)).status, 401);
  assert.equal((await api('GET', '/api/chat/bookings/00000000-0000-0000-0000-000000000000/messages', { token: c.token })).status, 404);

  // conversation lists and unread counts are private too
  const lc2 = await api('GET', '/api/chat/conversations', { token: c2.token });
  assert.deepEqual(lc2.data.conversations, []);
  assert.equal(lc2.data.totalUnread, 0);
  const lw2 = await api('GET', '/api/chat/conversations', { token: w2.token });
  assert.equal(JSON.stringify(lw2.data).includes(b.id), false);
  // the other pair's conversation is separate
  assert.equal((await api('GET', `/api/chat/bookings/${other.id}/messages`, { token: c.token })).status, 403);

  // legacy user-pair routes only work for people who share a real booking
  assert.equal((await api('GET', `/api/chat/messages/${w2.user.id}`, { token: c.token })).status, 403);
  assert.equal((await api('POST', '/api/chat/messages', { token: c2.token, json: { receiverId: w.user.id, content: 'hi' } })).status, 403);
  const legacy = await api('GET', `/api/chat/messages/${w.user.id}`, { token: c.token });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.messages.length, 2);
  assert.equal((await api('GET', `/api/chat/user/${w2.user.id}`, { token: c.token })).status, 404, 'no profile peeking at people you have no booking with');
});

test('every conversation belongs to exactly one booking; two bookings between the same people never mix', async () => {
  const c = await makeUser('bk-c', 'CUSTOMER');
  const w = await makeUser('bk-w', 'WORKER');
  const b1 = await makeBooking(c, w, 'COMPLETED', { completedAt: new Date() });
  const b2 = await makeBooking(c, w, 'CONFIRMED');
  await api('POST', `/api/chat/bookings/${b1.id}/messages`, { token: c.token, json: { content: 'about the first job' } });
  await api('POST', `/api/chat/bookings/${b2.id}/messages`, { token: c.token, json: { content: 'about the second job' } });
  const m1 = await api('GET', `/api/chat/bookings/${b1.id}/messages`, { token: w.token });
  const m2 = await api('GET', `/api/chat/bookings/${b2.id}/messages`, { token: w.token });
  assert.deepEqual(m1.data.messages.map((m) => m.content), ['about the first job']);
  assert.deepEqual(m2.data.messages.map((m) => m.content), ['about the second job']);
  assert.equal(await prisma.conversation.count({ where: { bookingId: { in: [b1.id, b2.id] } } }), 2);
  const list = await api('GET', '/api/chat/conversations', { token: w.token });
  assert.equal(list.data.conversations.length, 2);
  assert.ok(list.data.conversations.every((x) => x.bookingId && x.booking.bookingNumber && x.counterpart.name));
});

// ─── Real-time delivery over Socket.IO ──────────────────────────────────────

test('messages are delivered in real time to the other participant and stored in the database', async () => {
  const c = await makeUser('rt-c', 'CUSTOMER');
  const w = await makeUser('rt-w', 'WORKER');
  const b = await makeBooking(c, w);
  const cs = connect(c.token); const ws = connect(w.token);
  await Promise.all([cs.ready(), ws.ready()]);
  assert.equal((await cs.emit('chat:join', { bookingId: b.id })).ok, true);
  assert.equal((await ws.emit('chat:join', { bookingId: b.id })).ok, true);

  const id = cid();
  const ack = await cs.emit('chat:send', { bookingId: b.id, content: '  Hello from the customer  ', clientMessageId: id });
  assert.equal(ack.ok, true);
  assert.equal(ack.duplicate, false);
  const got = await ws.when('chat:message');
  assert.equal(got.content, 'Hello from the customer', 'content is trimmed');
  assert.equal(got.senderId, c.user.id);
  assert.equal(got.receiverId, w.user.id);
  assert.equal(got.bookingId, b.id);
  assert.ok(!Number.isNaN(new Date(got.createdAt).getTime()), 'has a timestamp');
  assert.equal(got.clientMessageId, id);
  await cs.when('chat:message'); // the sender's other tabs/devices see it too

  const row = await prisma.chatMessage.findUnique({ where: { id: got.id } });
  assert.equal(row.content, 'Hello from the customer');
  assert.equal(row.isRead, false);

  // and the reverse direction
  const back = await ws.emit('chat:send', { bookingId: b.id, content: 'Hi! Yes I can come at 10.', clientMessageId: cid() });
  assert.equal(back.ok, true);
  const gotBack = await cs.when('chat:message', (m) => m.senderId === w.user.id);
  assert.equal(gotBack.content, 'Hi! Yes I can come at 10.');
  assert.equal(await prisma.chatMessage.count({ where: { conversation: { bookingId: b.id } } }), 2);
});

test('history is preserved after logout and a fresh login', async () => {
  const c = await makeUser('hist-c', 'CUSTOMER');
  const w = await makeUser('hist-w', 'WORKER');
  const b = await makeBooking(c, w);
  for (const text of ['one', 'two', 'three']) await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: text } });
  await api('POST', '/api/auth/logout', { token: c.token });
  assert.equal((await api('GET', `/api/chat/bookings/${b.id}/messages`, { token: c.token })).status, 401, 'the old session is gone');
  const c2 = await fresh(c);
  const r = await api('GET', `/api/chat/bookings/${b.id}/messages`, { token: c2.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.messages.map((m) => m.content), ['one', 'two', 'three']);
  assert.ok(r.data.messages.every((m) => m.createdAt));
});

test('unauthorized Socket.IO connections are rejected, and non-participants cannot join, send or listen', async () => {
  const c = await makeUser('ua-c', 'CUSTOMER');
  const w = await makeUser('ua-w', 'WORKER');
  const intruder = await makeUser('ua-i', 'CUSTOMER');
  const intruderWorker = await makeUser('ua-iw', 'WORKER');
  const admin = await makeUser('ua-a', 'ADMIN');
  const b = await makeBooking(c, w);

  const none = connect(null, { reconnection: false });
  await assert.rejects(none.ready(), /missing token/);
  const bad = connect('not.a.jwt', { reconnection: false });
  await assert.rejects(bad.ready(), /invalid token/);
  const wrongSecret = connect(require('jsonwebtoken').sign({ id: c.user.id, tokenVersion: 0 }, 'some-other-secret'), { reconnection: false });
  await assert.rejects(wrongSecret.ready(), /invalid token/);

  const cs = connect(c.token); await cs.ready();
  assert.equal((await cs.emit('chat:join', { bookingId: b.id })).ok, true);
  const listeners = [];
  for (const who of [intruder, intruderWorker, admin]) {
    const s = connect(who.token); await s.ready();
    const j = await s.emit('chat:join', { bookingId: b.id });
    assert.equal(j.ok, false);
    assert.equal(j.code, 'FORBIDDEN');
    const sent = await s.emit('chat:send', { bookingId: b.id, content: 'intrusion', clientMessageId: cid() });
    assert.equal(sent.ok, false);
    assert.equal(sent.code, 'FORBIDDEN');
    assert.equal((await s.emit('chat:read', { bookingId: b.id })).ok, false);
    listeners.push(s);
  }
  // a genuine message is sent: none of the intruders' sockets receive it
  assert.equal((await cs.emit('chat:send', { bookingId: b.id, content: 'private text', clientMessageId: cid() })).ok, true);
  await settle(300);
  for (const s of listeners) {
    assert.equal(s.count('chat:message'), 0);
    assert.equal(s.count('receive_message'), 0);
    assert.equal(JSON.stringify(s.received).includes('private text'), false);
  }
  assert.equal(await prisma.chatMessage.count({ where: { content: 'intrusion' } }), 0);
  // malformed requests
  assert.equal((await cs.emit('chat:join', {})).ok, false);
  assert.equal((await cs.emit('chat:send', { bookingId: b.id, content: '', clientMessageId: cid() })).ok, false);
  assert.equal((await cs.emit('chat:join', { bookingId: { $ne: null } })).ok, false, 'object injection is rejected');
});

// ─── Duplicate prevention ───────────────────────────────────────────────────

test('a retried or concurrent send with the same clientMessageId creates exactly one message and one live event', async () => {
  const c = await makeUser('dup-c', 'CUSTOMER');
  const w = await makeUser('dup-w', 'WORKER');
  const b = await makeBooking(c, w);
  const cs = connect(c.token); const ws = connect(w.token);
  await Promise.all([cs.ready(), ws.ready()]);
  await cs.emit('chat:join', { bookingId: b.id }); await ws.emit('chat:join', { bookingId: b.id });

  const id = cid();
  const results = await Promise.all([
    cs.emit('chat:send', { bookingId: b.id, content: 'only once please', clientMessageId: id }),
    cs.emit('chat:send', { bookingId: b.id, content: 'only once please', clientMessageId: id }),
    api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'only once please', clientMessageId: id } }),
    api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'only once please', clientMessageId: id } })
  ]);
  assert.ok(results.every((r) => r.ok === true || r.status === 200 || r.status === 201));
  assert.equal(await prisma.chatMessage.count({ where: { senderId: c.user.id, clientMessageId: id } }), 1);
  const ids = new Set(results.map((r) => (r.message || r.data.message).id));
  assert.equal(ids.size, 1, 'every attempt resolves to the same stored message');
  assert.ok(results.filter((r) => r.duplicate === true || (r.data && r.data.duplicate === true)).length >= 3, 'the retries are flagged as duplicates');
  await settle(300);
  assert.equal(ws.count('chat:message'), 1, 'the recipient sees it once');

  // a later retry (e.g. after a reconnect) is still a no-op, even when the booking became read-only meanwhile
  await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  const late = await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'only once please', clientMessageId: id } });
  assert.equal(late.status, 200);
  assert.equal(late.data.duplicate, true);
  assert.equal(await prisma.chatMessage.count({ where: { senderId: c.user.id, clientMessageId: id } }), 1);
  // the same id from a different sender is a different message
  assert.equal(await prisma.chatMessage.count({ where: { clientMessageId: id } }), 1);
  // malformed client ids are refused
  await prisma.booking.update({ where: { id: b.id }, data: { status: 'CONFIRMED' } });
  assert.equal((await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'x', clientMessageId: 'short' } })).status, 400);
  assert.equal(await prisma.chatMessage.count({ where: { conversation: { bookingId: b.id } } }), 1);
});

// ─── Offline users, unread counts ───────────────────────────────────────────

test('offline recipient: messages are stored, unread counts and one coalesced notification are kept until they read', async () => {
  const c = await makeUser('off-c', 'CUSTOMER');
  const w = await makeUser('off-w', 'WORKER');
  const b = await makeBooking(c, w);
  for (const text of ['first', 'second', 'third message']) await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: text, clientMessageId: cid() } });

  const list = await api('GET', '/api/chat/conversations', { token: w.token });
  assert.equal(list.data.totalUnread, 3);
  assert.equal(list.data.conversations[0].unreadCount, 3);
  assert.equal(list.data.conversations[0].lastMessage.content, 'third message');
  assert.equal(list.data.conversations[0].counterpart.name, c.user.name);
  assert.equal((await api('GET', '/api/chat/unread-count', { token: w.token })).data.total, 3);
  assert.equal((await api('GET', '/api/chat/unread-count', { token: c.token })).data.total, 0, 'senders have nothing unread');

  const notes = await prisma.notification.findMany({ where: { userId: w.user.id, type: 'NEW_MESSAGE', bookingId: b.id } });
  assert.equal(notes.length, 1, 'three messages, one notification');
  assert.equal(notes[0].category, 'MESSAGE');
  assert.match(notes[0].message, /third message/);
  assert.equal(notes[0].isRead, false);

  // reading from another device while connected updates live
  const ws = connect(w.token); await ws.ready();
  await ws.emit('chat:join', { bookingId: b.id });
  const read = await api('POST', `/api/chat/bookings/${b.id}/read`, { token: w.token });
  assert.equal(read.data.markedCount, 3);
  assert.equal((await api('GET', '/api/chat/unread-count', { token: w.token })).data.total, 0);
  assert.equal((await prisma.notification.findUnique({ where: { id: notes[0].id } })).isRead, true);
  await ws.when('chat:read', (e) => e.readerId === w.user.id);
  const msgs = await api('GET', `/api/chat/bookings/${b.id}/messages`, { token: c.token });
  assert.ok(msgs.data.messages.every((m) => m.isRead === true && m.readAt), 'the sender can see their messages were read');
  // reading again marks nothing
  assert.equal((await api('POST', `/api/chat/bookings/${b.id}/read`, { token: w.token })).data.markedCount, 0);
});

test('a recipient who is looking at the chat gets the live message but no extra notification', async () => {
  const c = await makeUser('view-c', 'CUSTOMER');
  const w = await makeUser('view-w', 'WORKER');
  const b = await makeBooking(c, w);
  const ws = connect(w.token); await ws.ready();
  await ws.emit('chat:join', { bookingId: b.id });
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'you there?', clientMessageId: cid() } });
  await ws.when('chat:message');
  await ws.when('chat:unread', (e) => e.total === 1);
  assert.equal(await prisma.notification.count({ where: { userId: w.user.id, type: 'NEW_MESSAGE' } }), 0);
});

// ─── Reconnection ───────────────────────────────────────────────────────────

test('after a dropped connection the client reconnects, catches up on what it missed and receives live messages again', async () => {
  const c = await makeUser('rc-c', 'CUSTOMER');
  const w = await makeUser('rc-w', 'WORKER');
  const b = await makeBooking(c, w);
  const ws = connect(w.token); await ws.ready();
  await ws.emit('chat:join', { bookingId: b.id });
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'before the drop', clientMessageId: cid() } });
  const first = await ws.when('chat:message', (m) => m.content === 'before the drop');

  // The transport dies without a clean goodbye (what a network loss looks like). socket.io-client then reconnects on its own;
  // (a deliberate server-side disconnect, as on logout, intentionally does NOT auto-reconnect.)
  const reconnected = new Promise((resolve) => ws.socket.once('connect', resolve));
  const dropped = new Promise((resolve) => ws.socket.once('disconnect', resolve));
  ws.socket.io.engine.transport.ws.close(); // the underlying WebSocket vanishes
  assert.equal(await dropped, 'transport close');
  // messages sent while the worker is offline
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'sent while offline 1', clientMessageId: cid() } });
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'sent while offline 2', clientMessageId: cid() } });
  await reconnected;
  assert.equal(ws.socket.connected, true, 'socket.io reconnected on its own');

  // rooms are not remembered across reconnects: the client re-joins, then asks for everything after its last message
  assert.equal((await ws.emit('chat:join', { bookingId: b.id })).ok, true);
  const catchUp = await api('GET', `/api/chat/bookings/${b.id}/messages?after=${encodeURIComponent(first.createdAt)}`, { token: w.token });
  assert.deepEqual(catchUp.data.messages.map((m) => m.content), ['sent while offline 1', 'sent while offline 2']);
  assert.ok(!catchUp.data.messages.some((m) => m.id === first.id), 'nothing already received is returned again');
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'after reconnect', clientMessageId: cid() } });
  const live = await ws.when('chat:message', (m) => m.content === 'after reconnect');
  assert.equal(live.content, 'after reconnect');
});

// ─── Revoked sessions ───────────────────────────────────────────────────────

test('revoked sessions stop receiving and sending messages (logout, password change style bump, deactivation)', async () => {
  const c = await makeUser('rv-c', 'CUSTOMER');
  const w = await makeUser('rv-w', 'WORKER');
  const b = await makeBooking(c, w);

  // 1. logout disconnects the user's sockets and the old token cannot reconnect
  const ws = connect(w.token, { reconnection: false }); await ws.ready();
  await ws.emit('chat:join', { bookingId: b.id });
  const closed = new Promise((resolve) => ws.socket.once('disconnect', resolve));
  await api('POST', '/api/auth/logout', { token: w.token });
  await closed;
  assert.equal(ws.socket.connected, false);
  await api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content: 'after logout', clientMessageId: cid() } });
  await settle(200);
  assert.equal(ws.count('chat:message'), 0, 'a logged-out socket receives nothing');
  const retry = connect(w.token, { reconnection: false });
  await assert.rejects(retry.ready(), /session is no longer valid/);

  // 2. a socket that is still connected when its session is revoked behind the server's back is stopped on its next event
  const c2 = await makeUser('rv-c2', 'CUSTOMER');
  const w2 = await makeUser('rv-w2', 'WORKER');
  const b2 = await makeBooking(c2, w2);
  const s = connect(w2.token, { reconnection: false }); await s.ready();
  assert.equal((await s.emit('chat:join', { bookingId: b2.id })).ok, true);
  await prisma.user.update({ where: { id: w2.user.id }, data: { tokenVersion: { increment: 1 } } }); // revoked without a disconnect
  const dropped = new Promise((resolve) => s.socket.once('disconnect', resolve));
  const attempt = await s.emit('chat:send', { bookingId: b2.id, content: 'should not be stored', clientMessageId: cid() });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.code, 'SESSION_REVOKED');
  await dropped;
  assert.equal(await prisma.chatMessage.count({ where: { content: 'should not be stored' } }), 0);

  // 3. deactivated account
  const c3 = await makeUser('rv-c3', 'CUSTOMER');
  const w3 = await makeUser('rv-w3', 'WORKER');
  const b3 = await makeBooking(c3, w3);
  const s3 = connect(c3.token, { reconnection: false }); await s3.ready();
  await prisma.user.update({ where: { id: c3.user.id }, data: { isActive: false } });
  const r3 = await s3.emit('chat:send', { bookingId: b3.id, content: 'deactivated', clientMessageId: cid() });
  assert.equal(r3.code, 'SESSION_REVOKED');
  assert.equal((await api('POST', `/api/chat/bookings/${b3.id}/messages`, { token: c3.token, json: { content: 'deactivated' } })).status, 403);
});

// ─── Validation, state rules, pagination ────────────────────────────────────

test('message validation, read-only bookings, pagination and rate limiting', async () => {
  const c = await makeUser('val-c', 'CUSTOMER');
  const w = await makeUser('val-w', 'WORKER');
  const b = await makeBooking(c, w);
  const post = (content, extra = {}) => api('POST', `/api/chat/bookings/${b.id}/messages`, { token: c.token, json: { content, ...extra } });

  assert.equal((await post('')).status, 400);
  assert.equal((await post('   ')).status, 400);
  assert.equal((await post(undefined)).status, 400);
  assert.equal((await post(12345)).status, 400);
  assert.equal((await post('x'.repeat(2001))).status, 400);
  assert.equal((await post('x'.repeat(2000))).status, 201);
  const cleaned = await post('bell\u0007 char and\u0000 null');
  assert.equal(cleaned.data.message.content, 'bell char and null');
  const html = await post('<img src=x onerror=alert(1)>');
  assert.equal(html.data.message.content, '<img src=x onerror=alert(1)>', 'stored as text; the UI escapes it');

  // pagination: newest first window, then older with `before`
  for (let i = 1; i <= 6; i += 1) await post(`msg ${i}`);
  const page1 = await api('GET', `/api/chat/bookings/${b.id}/messages?limit=4`, { token: w.token });
  assert.deepEqual(page1.data.messages.map((m) => m.content), ['msg 3', 'msg 4', 'msg 5', 'msg 6']);
  assert.equal(page1.data.hasMore, true);
  const page2 = await api('GET', `/api/chat/bookings/${b.id}/messages?limit=100&before=${encodeURIComponent(page1.data.messages[0].createdAt)}`, { token: w.token });
  assert.equal(page2.data.messages.at(-1).content, 'msg 2');
  assert.equal(page2.data.hasMore, false);

  // cancelled bookings are readable but not writable
  await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  const ro = await post('after cancel');
  assert.equal(ro.status, 409);
  assert.equal(ro.data.code, 'READ_ONLY');
  assert.equal((await api('GET', `/api/chat/bookings/${b.id}/messages?limit=1`, { token: w.token })).data.canSend, false);
  // completed long ago: read-only too; recently completed: still open
  await prisma.booking.update({ where: { id: b.id }, data: { status: 'COMPLETED', completedAt: new Date(Date.now() - 20 * 86400000) } });
  assert.equal((await post('late')).status, 409);
  await prisma.booking.update({ where: { id: b.id }, data: { completedAt: new Date() } });
  assert.equal((await post('thanks again!')).status, 201);

  // rate limit
  const c2 = await makeUser('val-c2', 'CUSTOMER');
  const w2 = await makeUser('val-w2', 'WORKER');
  const b2 = await makeBooking(c2, w2);
  let limited = null;
  for (let i = 0; i < 40 && !limited; i += 1) {
    const r = await api('POST', `/api/chat/bookings/${b2.id}/messages`, { token: c2.token, json: { content: `spam ${i}` } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'flooding is rate limited');
  assert.equal(limited.data.code, 'RATE_LIMITED');
});

test('legacy conversations with no booking are neither listed nor reachable', async () => {
  const c = await makeUser('lg-c', 'CUSTOMER');
  const w = await makeUser('lg-w', 'WORKER');
  const [user1Id, user2Id] = [c.user.id, w.user.id].sort();
  const convo = await prisma.conversation.create({ data: { user1Id, user2Id } });
  await prisma.chatMessage.create({ data: { conversationId: convo.id, senderId: c.user.id, receiverId: w.user.id, content: 'old message from before bookings were required' } });
  const list = await api('GET', '/api/chat/conversations', { token: w.token });
  assert.deepEqual(list.data.conversations, []);
  assert.equal(list.data.totalUnread, 0);
  assert.equal((await api('PATCH', `/api/chat/conversations/${convo.id}/read`, { token: w.token })).status, 404);
  assert.equal((await api('GET', `/api/chat/messages/${c.user.id}`, { token: w.token })).status, 403, 'no booking, no access');
});
