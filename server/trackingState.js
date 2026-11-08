const activeTracking = new Map();
let socketServer = null;

const setSocketServer = (io) => {
  socketServer = io;
};

const getSocketServer = () => socketServer;

const broadcastBookingStatus = (bookingId, status, payload = {}) => {
  const key = String(bookingId);
  if (!socketServer) return false;
  socketServer.to(`booking:${key}`).emit('booking:status:changed', {
    bookingId: key,
    status,
    ...payload
  });
  return true;
};

const stopBookingTracking = (bookingId, message = 'Location sharing stopped.') => {
  const key = String(bookingId);
  const state = activeTracking.get(key);
  if (!state) return false;

  activeTracking.delete(key);
  socketServer?.to(`booking:${key}`).emit('tracking:stopped', {
    bookingId: key,
    workerId: state.workerId,
    customerId: state.customerId,
    message
  });
  return true;
};

const stopWorkerTracking = (workerId, message = 'Worker stopped sharing location.') => {
  let stopped = 0;
  for (const [bookingId, state] of activeTracking) {
    if (String(state.workerId) === String(workerId) && stopBookingTracking(bookingId, message)) {
      stopped += 1;
    }
  }
  return stopped;
};

// Drop every live socket belonging to a user (logout / password reset / credential rotation).
// Socket auth is only checked at connect time, so revoked sessions must be disconnected explicitly.
const disconnectUserSockets = (userId) => {
  if (!socketServer || !socketServer.sockets || !socketServer.sockets.sockets) return 0;
  let closed = 0;
  for (const socket of socketServer.sockets.sockets.values()) {
    if (socket.user && String(socket.user.id) === String(userId)) {
      socket.disconnect(true);
      closed += 1;
    }
  }
  return closed;
};

module.exports = {
  disconnectUserSockets,
  activeTracking,
  setSocketServer,
  getSocketServer,
  broadcastBookingStatus,
  stopBookingTracking,
  stopWorkerTracking
};
