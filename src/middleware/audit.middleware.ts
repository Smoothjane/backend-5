import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '@/middleware/auth.middleware';
import { getDb } from '@/utils/database';
import { logger } from '@/utils/logger';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Credentials never belong in an audit trail, even as a path.
const SKIP = [/^\/api\/v1\/auth\/(login|register)$/];

/**
 * Records every successful state-changing API call: who, what, when, from
 * where. Request bodies are never stored, so no passwords, hashes or
 * personal details leak into the log.
 */
export function auditTrail(req: Request, res: Response, next: NextFunction): void {
  // originalUrl keeps the /api mount prefix that req.path drops.
  const path = req.originalUrl.split('?')[0];
  if (!MUTATING.has(req.method) || SKIP.some((re) => re.test(path))) return next();

  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    let user: { sub?: string; email?: string; role?: string } = req.user ?? {};
    if (!user.sub && req.headers.authorization?.startsWith('Bearer ')) {
      try {
        user = verifyToken(req.headers.authorization.slice(7));
      } catch {
        user = {};
      }
    }
    try {
      getDb()
        .prepare(
          'INSERT INTO audit_log (user_id, user_email, role, action, path, status, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          user.sub ?? null,
          user.email ?? null,
          user.role ?? null,
          req.method,
          path,
          res.statusCode,
          req.ip ?? null,
        );
    } catch (err) {
      logger.error(`Audit write failed: ${(err as Error).message}`);
    }
  });
  next();
}
