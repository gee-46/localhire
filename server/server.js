const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const prisma = require('./config/prisma');
const { isSessionCurrent } = require('./services/authTokens');
const chatService = require('./services/chatService');
const { activeTracking, setSocketServer, stopBookingTracking, stopWorkerTracking } = require('./trackingState');
const trackingService = require('./services/trackingService');

dotenv.config({ path: path.resolve(__dirname, '.env') });

// ─── Startup environment guard ────────────────────────────────────────────────
// Production refuses to start with missing, placeholder or development-default secrets (see config/env.js).
// Outside production the same findings are warnings, except JWT_SECRET and DATABASE_URL which are always required.
const { enforce, isProduction, parseTrustProxy } = require('./config/env');
enforce(process.env);
{
  const keyId = process.env.RAZORPAY_KEY_ID;
  if (keyId && !/replace_with|your_/.test(keyId)) console.log(`[Server] Razorpay gateway credentials present (${keyId.startsWith('rzp_live_') ? 'LIVE' : 'TEST'} mode).`);
  if ((process.env.PAYOUT_MODE || 'LEDGER_ONLY').toUpperCase() === 'ROUTE') console.log('[Server] PAYOUT_MODE=ROUTE: worker payouts use Razorpay Route.');
  else console.log('[Server] PAYOUT_MODE=LEDGER_ONLY: worker earnings are recorded as owed; no payout transfers are attempted.');
}
// ─────────────────────────────────────────────────────────────────────────────

// Import Routes
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const jobRoutes = require('./routes/jobRoutes');
const appRoutes = require('./routes/appRoutes');
const chatRoutes = require('./routes/chatRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const adminRoutes = require('./routes/adminRoutes');
const escrowRoutes = require('./routes/escrowRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const pushRoutes = require('./routes/pushRoutes');
const workerRoutes = require('./routes/workerRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const marketplaceRoutes = require('./routes/marketplaceRoutes');

const app = express();
const server = http.createServer(app);

const bookingTrackingRoom = trackingService.roomFor;

const mapRole = (role) => {
  switch (role) {
    case 'WORKER':
      return 'Worker';
    case 'ADMIN':
      return 'Admin';
    default:
      return 'Customer';
  }
};

// ── Proxy, transport and header hardening ─────────────────────────────────────
app.disable('x-powered-by');
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== false) app.set('trust proxy', trustProxy);

// HTTPS only in production: redirect plain HTTP (needs TRUST_PROXY so the original scheme is known), and tell browsers
// to keep using HTTPS. The health check is exempt so platform probes over plain HTTP keep working.
app.use((req, res, next) => {
  if (isProduction()) {
    if (!req.secure && trustProxy !== false && process.env.FORCE_HTTPS !== 'false' && req.path !== '/api/health') {
      let host = req.headers.host;
      try { if (process.env.SERVER_PUBLIC_URL) host = new URL(process.env.SERVER_PUBLIC_URL).host; } catch (e) { /* fall back to the request host */ }
      return res.redirect(308, `https://${host}${req.originalUrl}`);
    }
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// In production an internal error message, SQL fragment or stack trace never reaches the client: the server log has it.
app.use((req, res, next) => {
  if (!isProduction()) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body)) {
      const { error, stack, ...rest } = body;
      body = rest;
    }
    return json(body);
  };
  next();
});

// Middleware
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const parseAllowedOrigins = () => {
  const envOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // Local development origins are never trusted in production.
  const dev = isProduction() ? [] : [
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173'
  ];
  return new Set([...dev, ...envOrigins]);
};

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. mobile apps, curl, or file:// where origin is 'null')
    if (!origin || (origin === 'null' && !isProduction())) {
      return callback(null, true);
    }
    const allowed = parseAllowedOrigins();
    if (allowed.has(origin)) {
      return callback(null, true);
    }
    // In development mode, allow any local port on localhost / 127.0.0.1
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
};

app.use(cors(corsOptions));

// Socket.io initialization
const io = new Server(server, {
  cors: corsOptions
});
setSocketServer(io);
trackingService.startSweeper();

io.use(async (socket, next) => {
  const headerToken = socket.handshake.headers.authorization;
  const socketToken = socket.handshake.auth?.token;
  const rawToken = typeof socketToken === 'string' ? socketToken : (typeof headerToken === 'string' ? headerToken : '');
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7) : rawToken;

  if (!token) {
    return next(new Error('Socket auth failed: missing token'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: String(decoded.id) },
      select: { id: true, role: true, tokenVersion: true, isActive: true, isEmailVerified: true }
    });

    if (!user) {
      return next(new Error('Socket auth failed: user not found'));
    }

    if (!isSessionCurrent(decoded, user) || user.isActive === false || user.isEmailVerified === false) {
      return next(new Error('Socket auth failed: session is no longer valid'));
    }

    socket.user = {
      id: user.id,
      role: mapRole(user.role)
    };
    socket.data.decoded = decoded;
    return next();
  } catch (error) {
    console.error('[Socket Auth] Token verification failed:', error.message);
    return next(new Error('Socket auth failed: invalid token'));
  }
});

// Socket.io connection logic
io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);

  if (socket.user?.id) {
    socket.join(`user:${socket.user.id}`);
  }

  // ── Booking chat ─────────────────────────────────────────────────────────────────────────
  // A socket authenticated once at connect time must not keep receiving messages after its session was revoked
  // (logout, password change, deactivation). Logout/credential changes disconnect sockets directly; this also
  // re-checks the session on every chat event so even a missed disconnect cannot be used.
  const sessionStillValid = async () => {
    try {
      const u = await prisma.user.findUnique({ where: { id: String(socket.user.id) }, select: { tokenVersion: true, isActive: true, isEmailVerified: true } });
      return Boolean(u) && isSessionCurrent(socket.data.decoded, u) && u.isActive !== false && u.isEmailVerified !== false;
    } catch (e) { return false; }
  };
  const respond = (ack, payload, errorEvent = 'chat:error') => {
    if (typeof ack === 'function') ack(payload);
    else if (!payload.ok) socket.emit(errorEvent, { message: payload.error, code: payload.code });
  };
  const guard = (handler) => async (data, ack) => {
    try {
      if (!(await sessionStillValid())) {
        respond(ack, { ok: false, error: 'Your session is no longer valid. Please sign in again.', code: 'SESSION_REVOKED' });
        socket.disconnect(true);
        return;
      }
      await handler(data || {}, ack);
    } catch (e) {
      if (e instanceof chatService.ChatError) return respond(ack, { ok: false, error: e.message, code: e.code || 'CHAT_ERROR' });
      console.error('[Socket Chat] handler failed:', e);
      respond(ack, { ok: false, error: 'Something went wrong. Please try again.', code: 'SERVER_ERROR' });
    }
  };

  socket.on('chat:join', guard(async ({ bookingId }, ack) => {
    const { canSend, readOnlyReason } = await chatService.loadBooking(bookingId, socket.user.id); // throws 403/404 for non-participants
    socket.join(chatService.roomFor(bookingId));
    respond(ack, { ok: true, bookingId, canSend, readOnlyReason });
  }));

  socket.on('chat:leave', (data) => {
    if (data && typeof data.bookingId === 'string') socket.leave(chatService.roomFor(data.bookingId));
  });

  socket.on('chat:send', guard(async ({ bookingId, content, clientMessageId }, ack) => {
    const out = await chatService.sendMessage({ bookingId, senderId: socket.user.id, content, clientMessageId });
    respond(ack, { ok: true, duplicate: out.duplicate, message: out.message });
  }));

  socket.on('chat:read', guard(async ({ bookingId }, ack) => {
    const r = await chatService.markRead({ bookingId, userId: socket.user.id });
    respond(ack, { ok: true, marked: r.marked });
  }));

  // ── Journey tracking ─────────────────────────────────────────────────────────────────────
  // Same session re-check as chat: a revoked session must not keep receiving a worker's location.
  const trackRespond = (ack, payload, bookingId) => {
    if (typeof ack === 'function') ack(payload);
    else if (!payload.ok) socket.emit('tracking:error', { bookingId, message: payload.error, code: payload.code });
  };
  const trackGuard = (handler) => async (data, ack) => {
    const bookingId = data && typeof data.bookingId === 'string' ? data.bookingId : undefined;
    try {
      if (!(await sessionStillValid())) {
        trackRespond(ack, { ok: false, error: 'Your session is no longer valid. Please sign in again.', code: 'SESSION_REVOKED' }, bookingId);
        socket.disconnect(true);
        return;
      }
      await handler(data || {}, ack, bookingId);
    } catch (e) {
      if (e instanceof trackingService.TrackError) return trackRespond(ack, { ok: false, error: e.message, code: e.code }, bookingId);
      console.error('[Socket Tracking] handler failed:', e);
      trackRespond(ack, { ok: false, error: 'Tracking is unavailable right now. Please try again.', code: 'SERVER_ERROR' }, bookingId);
    }
  };

  const ACTIVE_FOR_ROOM = ['CONFIRMED', 'DISPATCHED', 'IN_PROGRESS', 'AWAITING_CUSTOMER_CONFIRMATION'];
  const statePayload = (view, state, message) => ({
    bookingId: view.bookingId, active: Boolean(view.sharing && state && state.workerConnected !== false), workerId: view.worker.id, customerId: state ? state.customerId : undefined,
    startedAt: state ? state.startedAt : (view.journeyStartedAt || null), lastLocation: view.location, lastUpdated: view.lastUpdated, freshness: view.freshness,
    journeyStatus: view.journeyStatus, distanceKm: view.distanceKm, eta: null, sharing: view.sharing, message
  });

  const handleBookingJoin = trackGuard(async ({ bookingId }, ack) => {
    const { booking, role } = await trackingService.loadForAccess(bookingId, socket.user.id); // 400/403/404 for anyone else
    if (!ACTIVE_FOR_ROOM.includes(booking.status)) throw new trackingService.TrackError(409, 'Tracking is available only for accepted, active bookings.', 'NOT_ACTIVE');
    const room = trackingService.roomFor(bookingId);
    socket.join(room);
    socket.data.trackingRoom = room;
    const view = trackingService.viewFor({ booking, role });

    if (role === 'Worker') {
      (socket.data.trackingBookings = socket.data.trackingBookings || new Set()).add(bookingId);
      let state = activeTracking.get(bookingId);
      if (view.sharing) {
        if (!state) {
          state = { bookingId, workerId: booking.workerId, customerId: booking.customerId, startedAt: new Date().toISOString(), lastLocation: view.location, lastUpdated: view.lastUpdated, lastAcceptedAt: 0, lastPersistAt: 0, status: 'ACTIVE', staleNotified: false, workerConnected: true };
          activeTracking.set(bookingId, state);
        } else { state.workerConnected = true; }
        io.to(room).emit('tracking:state', statePayload(view, state, 'The professional is sharing their location.'));
      } else {
        socket.emit('tracking:state', statePayload(view, null, 'Location is shared only after you start the journey.'));
      }
      trackRespond(ack, { ok: true, tracking: view }, bookingId);
      return;
    }

    const state = activeTracking.get(bookingId);
    const msg = !view.sharing
      ? (view.journeyStatus === 'WORKER_ARRIVED' ? 'The professional has arrived.' : 'Live tracking starts when the professional begins their journey.')
      : (view.location ? (view.freshness === 'live' ? 'Tracking is live.' : 'Showing the last known position.') : 'The professional has started the journey. Waiting for their first location update.');
    socket.emit('tracking:state', statePayload(view, state, msg));
    trackRespond(ack, { ok: true, tracking: view }, bookingId);
  });

  const handleWorkerLocationUpdate = trackGuard(async (data, ack, bookingId) => {
    const r = await trackingService.recordLocation({ bookingId, workerId: socket.user.id, latitude: data.latitude, longitude: data.longitude, accuracy: data.accuracy, timestamp: data.timestamp });
    socket.join(trackingService.roomFor(bookingId));
    (socket.data.trackingBookings = socket.data.trackingBookings || new Set()).add(bookingId);
    trackRespond(ack, { ok: true, accepted: r.accepted, throttled: Boolean(r.throttled) }, bookingId);
  });

  const handleBookingLeave = trackGuard(async ({ bookingId }, ack) => {
    const { role } = await trackingService.loadForAccess(bookingId, socket.user.id);
    socket.leave(trackingService.roomFor(bookingId));
    if (role === 'Worker') {
      // pausing: the last position stays (marked as not live); the journey itself is unchanged
      trackingService.markWorkerGone(bookingId, 'worker_paused');
      if (socket.data.trackingBookings) socket.data.trackingBookings.delete(bookingId);
    }
    trackRespond(ack, { ok: true }, bookingId);
  });

  // Real-time tracking events (the original names are kept)
  socket.on('booking:join', handleBookingJoin);
  socket.on('tracking:subscribe', handleBookingJoin);
  socket.on('tracking:start', handleBookingJoin);

  socket.on('worker:location:update', handleWorkerLocationUpdate);
  socket.on('tracking:update', handleWorkerLocationUpdate);

  socket.on('booking:leave', handleBookingLeave);
  socket.on('tracking:stop', handleBookingLeave);

  // A worker whose connection dropped (browser closed, phone locked, network lost) must not look "live".
  socket.on('disconnect', () => {
    const bookings = socket.data.trackingBookings;
    if (bookings && socket.user?.role === 'Worker') {
      for (const bookingId of bookings) trackingService.markWorkerGone(bookingId, 'worker_disconnected');
    }
    console.log(`[Socket] User disconnected: ${socket.id}`);
  });
});

// API Status Route
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'LocalHire API is running live' });
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/applications', appRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/escrow', escrowRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/worker', workerRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/marketplace', marketplaceRoutes);

// ── Static Frontend Serving ──────────────────────────────────────────────────
const publicDirectory = path.resolve(__dirname, '..', 'public');
app.use(express.static(publicDirectory));

// Fallback to index.html for client-side navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(publicDirectory, 'index.html'));
});
// ─────────────────────────────────────────────────────────────────────────────

// Final error handler: JSON, no internals. Express's default handler would print a stack trace when NODE_ENV is not "production".
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && /not allowed by CORS/i.test(err.message || '')) return res.status(403).json({ success: false, message: 'This origin is not allowed.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'The request body is not valid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'The request body is too large.' });
  console.error('[Server] Unhandled error:', isProduction() ? (err && err.message) : err);
  return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${PORT} is already in use. Stop the stale process and try again.`);
      console.error('[Server] Example: Get-NetTCPConnection -LocalPort 5000 | Stop-Process -Id $_.OwningProcess -Force');
      process.exit(1);
    }

    console.error('[Server] Unhandled server error:', err);
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(`[Server] LocalHire API server running on port ${PORT}`);
  });
};

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  io,
  activeTracking,
  bookingTrackingRoom,
  mapRole,
  stopBookingTracking,
  stopWorkerTracking
};
