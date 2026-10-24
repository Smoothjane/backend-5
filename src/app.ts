import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from '@/config/config';
import { auditTrail } from '@/middleware/audit.middleware';
import { errorHandler } from '@/middleware/error.middleware';
import { notFoundHandler } from '@/middleware/notFound.middleware';
import { DEFAULT_ROLE_LIMITS, roleRateLimit } from '@/middleware/rateLimit.middleware';
import analyticsRoutes from '@/routes/analytics.routes';
import auditRoutes from '@/routes/audit.routes';
import authRoutes from '@/routes/auth.routes';
import customerRoutes from '@/routes/customers.routes';
import paymentRoutes from '@/routes/payments.routes';
import productRoutes from '@/routes/products.routes';
import storeRoutes from '@/routes/store.routes';
import transactionRoutes from '@/routes/transactions.routes';
import userRoutes from '@/routes/users.routes';
import { isDatabaseHealthy } from '@/utils/database';
import { logger } from '@/utils/logger';

export function createApp(): express.Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: config.client.url,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(
    '/api',
    roleRateLimit(
      config.isTest
        ? { anonymous: 10_000, cashier: 10_000, manager: 10_000, admin: 10_000 }
        : DEFAULT_ROLE_LIMITS,
    ),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', auditTrail);
  app.use(compression());
  if (!config.isTest) {
    app.use(
      morgan(config.isProd ? 'combined' : 'dev', {
        stream: { write: (line) => logger.http(line.trim()) },
      }),
    );
  }

  app.get('/health', (_req, res) => {
    const database = isDatabaseHealthy() ? 'up' : 'down';
    // Load balancers take a 503 as "send traffic elsewhere".
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'OK' : 'DEGRADED',
      database,
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.2.0',
      environment: config.env,
      stellarNetwork: config.stellar.network,
    });
  });

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/store', storeRoutes);
  app.use('/api/v1/products', productRoutes);
  app.use('/api/v1/customers', customerRoutes);
  app.use('/api/v1/transactions', transactionRoutes);
  app.use('/api/v1/payments', paymentRoutes);
  app.use('/api/v1/analytics', analyticsRoutes);
  app.use('/api/v1/audit', auditRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
