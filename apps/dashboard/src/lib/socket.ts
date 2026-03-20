import { io, Socket } from 'socket.io-client';

const WS_URL = import.meta.env.VITE_WS_URL || '';
let socket: Socket | null = null;

export function connectSocket(token?: string, workerId?: string): Socket {
  if (socket?.connected) return socket;

  socket = io(WS_URL, {
    auth: { token },
    query: { workerId },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });

  socket.on('connect', () => {
    console.log('🔌 WebSocket connected:', socket?.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('🔌 WebSocket disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.warn('🔌 WebSocket error:', err.message);
  });

  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
