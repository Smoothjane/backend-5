import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { summarize } from '@/services/analytics.service';
import { getDb } from '@/utils/database';
import { asyncHandler, boundedInt, sendSuccess } from '@/utils/helpers';

const router = Router();
router.use(authenticate);

const COMPLETED = "status = 'completed'";

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    // Defaults to today (UTC); ?days=N widens the window.
    sendSuccess(res, summarize(boundedInt(req.query.days, 1, 1, 365)));
  }),
);

router.get(
  '/revenue-by-day',
  asyncHandler(async (req, res) => {
    const days = boundedInt(req.query.days, 7, 1, 90);
    const rows = getDb()
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS sales, SUM(total_cents) AS revenue
         FROM transactions
         WHERE ${COMPLETED} AND created_at >= datetime('now', 'start of day', '-${days - 1} days')
         GROUP BY day ORDER BY day`,
      )
      .all() as { day: string; sales: number; revenue: number }[];

    // Fill gaps so charts get one point per day, including zero days.
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const day = d.toISOString().slice(0, 10);
      const row = byDay.get(day);
      series.push({ day, sales: row?.sales ?? 0, revenueCents: row?.revenue ?? 0 });
    }
    sendSuccess(res, series);
  }),
);

router.get(
  '/hourly',
  asyncHandler(async (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS sales, SUM(total_cents) AS revenue
         FROM transactions WHERE ${COMPLETED} AND created_at >= datetime('now', '-30 days')
         GROUP BY hour`,
      )
      .all() as { hour: number; sales: number; revenue: number }[];
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    sendSuccess(
      res,
      Array.from({ length: 24 }, (_, hour) => ({
        hour,
        sales: byHour.get(hour)?.sales ?? 0,
        revenueCents: byHour.get(hour)?.revenue ?? 0,
      })),
    );
  }),
);

router.get(
  '/top-products',
  asyncHandler(async (req, res) => {
    const limit = boundedInt(req.query.limit, 5, 1, 50);
    const days = boundedInt(req.query.days, 30, 1, 365);
    const rows = getDb()
      .prepare(
        `SELECT i.product_id AS productId, i.name, i.sku, SUM(i.quantity) AS units,
                SUM(i.line_total_cents) AS revenueCents
         FROM transaction_items i JOIN transactions t ON t.id = i.transaction_id
         WHERE t.${COMPLETED} AND t.created_at >= datetime('now', '-${days} days')
         GROUP BY i.product_id ORDER BY units DESC, revenueCents DESC LIMIT ?`,
      )
      .all(limit);
    sendSuccess(res, rows);
  }),
);

export default router;
