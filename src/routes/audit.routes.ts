import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { getDb } from '@/utils/database';
import { asyncHandler, paginatedResponse, parsePagination } from '@/utils/helpers';

const router = Router();
router.use(authenticate, authorize('admin'));

/** GET /audit?userId=&action=POST&page=1 - newest first. Admin only. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = parsePagination(req.query, 200);
    const clauses: string[] = [];
    const params: string[] = [];
    if (req.query.userId) {
      clauses.push('user_id = ?');
      params.push(String(req.query.userId));
    }
    if (req.query.action) {
      clauses.push('action = ?');
      params.push(String(req.query.action).toUpperCase());
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const db = getDb();
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`).get(...params) as { n: number }
    ).n;
    const rows = db
      .prepare(
        `SELECT id, user_id AS userId, user_email AS userEmail, role, action, path, status, ip, created_at AS createdAt
         FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset);
    paginatedResponse(res, rows, total, page);
  }),
);

export default router;
