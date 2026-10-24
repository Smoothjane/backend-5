import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { badRequest } from '@/middleware/error.middleware';
import { getDb } from '@/utils/database';
import { asyncHandler, boundedInt, sendSuccess } from '@/utils/helpers';
import { toFtsQuery } from '@/utils/searchIndex';

const router = Router();
router.use(authenticate);

const KINDS = ['product', 'customer', 'sale'] as const;
type Kind = (typeof KINDS)[number];

interface Hit {
  kind: Kind;
  id: string;
  title: string;
  snippet: string;
  score: number;
}

/**
 * GET /search?q=flat wh&types=product,sale&limit=20
 *
 * One ranked search across products, customers and sales (reference, note,
 * or any item on the sale). Results carry a highlighted snippet with
 * matches wrapped in [[ ]] for the client to style.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = toFtsQuery(String(req.query.q ?? ''));
    if (!q) throw badRequest('Enter something to search for');
    const types = String(req.query.types ?? KINDS.join(','))
      .split(',')
      .filter((t): t is Kind => (KINDS as readonly string[]).includes(t));
    if (!types.length) throw badRequest(`types must be any of ${KINDS.join(', ')}`);
    const limit = boundedInt(req.query.limit, 20, 1, 50);

    const rows = getDb()
      .prepare(
        `SELECT kind, ref_id AS id, title,
                snippet(search_index, -1, '[[', ']]', '...', 10) AS snippet,
                bm25(search_index, 0, 0, 10.0, 1.0) AS score
         FROM search_index
         WHERE search_index MATCH ? AND kind IN (${types.map(() => '?').join(',')})
         ORDER BY score
         LIMIT 200`,
      )
      .all(q, ...types) as unknown as Hit[];

    // A sale can match on several rows (reference and items); keep its best.
    const best = new Map<string, Hit>();
    for (const r of rows) {
      const key = `${r.kind}:${r.id}`;
      if (!best.has(key)) best.set(key, r);
    }
    const hits = [...best.values()].slice(0, limit);

    // Sale item rows have no title; show the sale reference instead.
    const missing = hits.filter((h) => h.kind === 'sale' && !h.title).map((h) => h.id);
    if (missing.length) {
      const refs = getDb()
        .prepare(
          `SELECT id, reference FROM transactions WHERE id IN (${missing.map(() => '?').join(',')})`,
        )
        .all(...missing) as { id: string; reference: string }[];
      const byId = new Map(refs.map((r) => [r.id, r.reference]));
      for (const h of hits) if (h.kind === 'sale' && !h.title) h.title = byId.get(h.id) ?? '';
    }

    sendSuccess(
      res,
      hits.map(({ kind, id, title, snippet }) => ({ kind, id, title, snippet })),
    );
  }),
);

export default router;
