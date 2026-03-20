/**
 * Socket.io WebSocket server for real-time updates.
 * Rooms by worker_id. Pushes RT_UPDATE, DISRUPTION_ALERT, CLAIM_STATE.
 */
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-to-a-random-64-char-secret';

let io = null;

function setupWebSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware for WebSocket ───────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      // Allow unauthenticated connections for development
      socket.user = { workerId: socket.handshake.query?.workerId || 'anonymous' };
      return next();
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    const workerId = socket.user?.workerId || socket.handshake.query?.workerId;
    console.log(`🔌 WebSocket connected: ${workerId || socket.id}`);

    // Join worker-specific room
    if (workerId) {
      socket.join(`worker:${workerId}`);
    }

    // Join admin room if admin
    if (socket.user?.role === 'admin') {
      socket.join('admin');
    }

    socket.on('disconnect', (reason) => {
      console.log(`🔌 WebSocket disconnected: ${workerId || socket.id} (${reason})`);
    });

    socket.on('subscribe:ward', (wardId) => {
      socket.join(`ward:${wardId}`);
    });
  });

  return io;
}

/**
 * Push RT_UPDATE to a specific worker.
 */
function pushRtUpdate(workerId, score, zone) {
  if (!io) return;
  io.to(`worker:${workerId}`).emit('RT_UPDATE', {
    type: 'RT_UPDATE',
    score,
    zone,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Push DISRUPTION_ALERT to a specific worker.
 */
function pushDisruptionAlert(workerId, level, details = {}) {
  if (!io) return;
  io.to(`worker:${workerId}`).emit('DISRUPTION_ALERT', {
    type: 'DISRUPTION_ALERT',
    level, // 'WARNING' | 'CLAIM_INITIATED'
    ...details,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Push CLAIM_STATE to a specific worker.
 */
function pushClaimState(workerId, state, payout = null) {
  if (!io) return;
  io.to(`worker:${workerId}`).emit('CLAIM_STATE', {
    type: 'CLAIM_STATE',
    state,
    payout,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Broadcast to admin room.
 */
function broadcastToAdmin(event, data) {
  if (!io) return;
  io.to('admin').emit(event, data);
}

function getIO() {
  return io;
}

module.exports = {
  setupWebSocket,
  pushRtUpdate,
  pushDisruptionAlert,
  pushClaimState,
  broadcastToAdmin,
  getIO,
};
