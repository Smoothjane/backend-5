import { getDb } from '@/utils/database';

const COMPLETED = "status = 'completed'";

export interface Summary {
  days: number;
  totalSales: number;
  totalRevenueCents: number;
  taxCents: number;
  discountCents: number;
  averageTicketCents: number;
  unitsSold: number;
  byMethod: { method: string; count: number; amountCents: number }[];
  refunds: number;
  voids: number;
  lowStockProducts: number;
  customers: number;
}

/** Sales summary for the last `days` days (1 = today, UTC). */
export function summarize(days = 1): Summary {
  const db = getDb();
  const since = `datetime('now', 'start of day', '-${days - 1} days')`;
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS sales, COALESCE(SUM(total_cents), 0) AS revenue,
              COALESCE(SUM(tax_cents), 0) AS tax, COALESCE(SUM(discount_cents), 0) AS discounts
       FROM transactions WHERE ${COMPLETED} AND created_at >= ${since}`,
    )
    .get() as { sales: number; revenue: number; tax: number; discounts: number };
  const byMethod = db
    .prepare(
      `SELECT p.method, COUNT(*) AS count, SUM(p.amount_cents) AS amount
       FROM payments p JOIN transactions t ON t.id = p.transaction_id
       WHERE p.status = 'completed' AND t.${COMPLETED} AND t.created_at >= ${since}
       GROUP BY p.method ORDER BY amount DESC`,
    )
    .all() as { method: string; count: number; amount: number }[];
  const items = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity), 0) AS units FROM transaction_items i
       JOIN transactions t ON t.id = i.transaction_id
       WHERE t.${COMPLETED} AND t.created_at >= ${since}`,
    )
    .get() as { units: number };
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM transactions WHERE status = 'refunded' AND created_at >= ${since}) AS refunds,
         (SELECT COUNT(*) FROM transactions WHERE status = 'void' AND created_at >= ${since}) AS voids,
         (SELECT COUNT(*) FROM products WHERE active = 1 AND stock <= low_stock_threshold) AS lowStock,
         (SELECT COUNT(*) FROM customers) AS customers`,
    )
    .get() as { refunds: number; voids: number; lowStock: number; customers: number };

  return {
    days,
    totalSales: totals.sales,
    totalRevenueCents: totals.revenue,
    taxCents: totals.tax,
    discountCents: totals.discounts,
    averageTicketCents: totals.sales ? Math.round(totals.revenue / totals.sales) : 0,
    unitsSold: items.units,
    byMethod: byMethod.map((m) => ({ method: m.method, count: m.count, amountCents: m.amount })),
    refunds: counts.refunds,
    voids: counts.voids,
    lowStockProducts: counts.lowStock,
    customers: counts.customers,
  };
}
