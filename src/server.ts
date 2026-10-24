import { createServer } from 'node:http';
import { app } from '@/app';
import { config } from '@/config/config';
import { attachRealtime, closeRealtime } from '@/services/realtime';
import { startPaymentWatcher, stopPaymentWatcher } from '@/services/paymentWatcher';
import { startBackupSchedule, stopBackupSchedule } from '@/utils/backup';
import { closeDatabase, connectDatabase } from '@/utils/database';
import { logger } from '@/utils/logger';
import { connectRedis } from '@/utils/redis';
import { closeQueues, setupQueues } from '@/utils/queue';
import { startEmailWorker } from '@/services/email.service';

export { app };

export const server = createServer(app);

async function start(): Promise<void> {
  await connectDatabase();
  await connectRedis();
  setupQueues();
  startEmailWorker();
  attachRealtime(server);
  startPaymentWatcher();
  startBackupSchedule();

  server.listen(config.port, () => {
    logger.info(`StellarPOS API listening on http://localhost:${config.port} (${config.env})`);
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, shutting down`);
  stopPaymentWatcher();
  stopBackupSchedule();
  closeQueues();
  await closeRealtime();
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
  // Do not hang forever on open keep-alive connections.
  setTimeout(() => process.exit(1), 10_000).unref();
}

if (require.main === module) {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  start().catch((err: Error) => {
    logger.error(`Failed to start: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });
}
