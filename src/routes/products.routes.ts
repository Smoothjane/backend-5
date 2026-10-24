import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { AppError, conflict, notFound } from '@/middleware/error.middleware';
import { validateBody } from '@/middleware/validate.middleware';
import { ProductModel, type ProductInput } from '@/models/product.model';
import { emit } from '@/services/realtime';
import { asyncHandler, paginatedResponse, parsePagination, sendSuccess } from '@/utils/helpers';
import {
  adjustStockSchema,
  createProductSchema,
  updateProductSchema,
} from '@/validation/product.validation';

const router = Router();
const canManage = [authenticate, authorize('admin', 'manager')];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = parsePagination(req.query, 200);
    const { items, total } = ProductModel.list(
      {
        search: req.query.search ? String(req.query.search) : undefined,
        category: req.query.category ? String(req.query.category) : undefined,
        lowStock: req.query.lowStock === 'true',
        includeInactive: req.query.includeInactive === 'true',
      },
      page,
    );
    paginatedResponse(res, items, total, page);
  }),
);

/**
 * Compact catalog for phones and tablets: every active product in one
 * response with only the fields a register needs. Responses carry an ETag,
 * so a client that already has the current catalog gets an empty 304.
 */
router.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    const { items } = ProductModel.list({}, { page: 1, limit: 10_000, offset: 0 });
    res.set('Cache-Control', 'private, no-cache');
    sendSuccess(
      res,
      items.map(({ id, name, sku, category, priceCents, stock, lowStock }) => ({
        id,
        name,
        sku,
        category,
        priceCents,
        stock,
        lowStock,
      })),
    );
  }),
);

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, ProductModel.categories());
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const product = ProductModel.findById(req.params.id);
    if (!product) throw notFound('Product');
    sendSuccess(res, product);
  }),
);

router.post(
  '/',
  ...canManage,
  validateBody(createProductSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as ProductInput;
    if (ProductModel.findBySku(input.sku)) throw conflict(`SKU ${input.sku} is already in use`);
    sendSuccess(res, ProductModel.create(input), 201);
  }),
);

router.put(
  '/:id',
  ...canManage,
  validateBody(updateProductSchema),
  asyncHandler(async (req, res) => {
    const fields = req.body as Partial<ProductInput>;
    if (!ProductModel.findById(req.params.id)) throw notFound('Product');
    if (fields.sku) {
      const other = ProductModel.findBySku(fields.sku);
      if (other && other.id !== req.params.id)
        throw conflict(`SKU ${fields.sku} is already in use`);
    }
    sendSuccess(res, ProductModel.update(req.params.id, fields));
  }),
);

router.post(
  '/:id/stock',
  ...canManage,
  validateBody(adjustStockSchema),
  asyncHandler(async (req, res) => {
    if (!ProductModel.findById(req.params.id)) throw notFound('Product');
    const { delta } = req.body as { delta: number };
    if (!ProductModel.adjustStock(req.params.id, delta)) {
      throw new AppError('Stock cannot go below zero', 409);
    }
    const product = ProductModel.findById(req.params.id)!;
    if (product.lowStock) emit('inventory:low', [product]);
    sendSuccess(res, product);
  }),
);

router.delete(
  '/:id',
  ...canManage,
  asyncHandler(async (req, res) => {
    if (!ProductModel.findById(req.params.id)) throw notFound('Product');
    const outcome = ProductModel.delete(req.params.id);
    sendSuccess(res, { id: req.params.id, outcome });
  }),
);

export default router;
