import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { config } from '@/config/config';
import { verifyToken } from '@/middleware/auth.middleware';
import { logger } from '@/utils/logger';

/**
 * Socket.IO events pushed to signed-in terminals. A single store room keeps
 * every register in sync: when a customer pays by QR on one terminal, the
 * dashboard on another updates immediately.
 */
export type RealtimeEvent =
  | 'payment:confirmed'
  | 'payment:expired'
  | 'transaction:completed'
  | 'inventory:low'
  | 'analytics:updated';

const STORE_ROOM = 'store';
let io: Server | null = null;

export function attachRealtime(server: HttpServer): Server {
  io = new Server(server, { cors: { origin: config.client.url, credentials: true } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.data.user = verifyToken(token);
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(STORE_ROOM);
    logger.debug(`Terminal connected: ${socket.data.user.email}`);
  });
  return io;
}

/** Broadcasts to every connected terminal. A no-op when sockets are not attached (tests, scripts). */
export function emit(event: RealtimeEvent, payload: unknown): void {
  io?.to(STORE_ROOM).emit(event, payload);
}

export function closeRealtime(): Promise<void> {
  return new Promise((resolve) => {
    if (!io) return resolve();
    io.close(() => resolve());
    io = null;
  });
}
