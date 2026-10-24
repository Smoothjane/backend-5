import { Router } from 'express';
import { authenticate, authorize } from '@/middleware/auth.middleware';
import { AppError, badRequest, notFound } from '@/middleware/error.middleware';
import { CustomerModel } from '@/models/customer.model';
import { queueEmail } from '@/services/email.service';
import { receiptEmail } from '@/services/receipt.service';
import { validateBody } from '@/middleware/validate.middleware';
import { PaymentModel } from '@/models/payment.model';
import { TransactionModel, type TransactionStatus } from '@/models/transaction.model';
import { asyncHandler, paginatedResponse, parsePagination, sendSuccess } from '@/utils/helpers';
import {
  createSaleSchema,
  emailReceiptSchema,
  refundSchema,
} from '@/validation/transaction.validation';

const router = Router();
router.use(authenticate);

const STATUSES: TransactionStatus[] = ['pending', 'completed', 'void', 'refunded'];

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = parsePagination(req.query);
    const status = STATUSES.find((s) => s === req.query.status);
    const { items, total } = TransactionModel.list(
      {
        status,
        customerId: req.query.customerId ? String(req.query.customerId) : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        search: req.query.search ? String(req.query.search) : undefined,
      },
      page,
    );
    paginatedResponse(res, items, total, page);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const sale = TransactionModel.findById(req.params.id);
    if (!sale) throw notFound('Transaction');
    sendSuccess(res, {
      ...sale,
      items: TransactionModel.findItemsByTransactionId(sale.id),
      payments: PaymentModel.findByTransactionId(sale.id),
    });
  }),
);

router.post(
  '/',
  validateBody(createSaleSchema),
  asyncHandler(async (req, res) => {
    const sale = TransactionModel.createSale({ ...req.body, userId: req.user!.sub });
    sendSuccess(res, { ...sale, items: TransactionModel.findItemsByTransactionId(sale.id) }, 201);
  }),
);

/** Emails the receipt to an address (or the sale's customer). Sent in the background. */
router.post(
  '/:id/receipt/email',
  validateBody(emailReceiptSchema),
  asyncHandler(async (req, res) => {
    const sale = TransactionModel.findById(req.params.id);
    if (!sale) throw notFound('Transaction');
    if (sale.status !== 'completed' && sale.status !== 'refunded') {
      throw new AppError('Only paid sales have a receipt to send', 409);
    }
    const to: string | null =
      req.body.email ??
      (sale.customerId ? (CustomerModel.findById(sale.customerId)?.email ?? null) : null);
    if (!to) throw badRequest('No email address: pass one, or attach a customer with an email');
    queueEmail(
      receiptEmail(
        to,
        sale,
        TransactionModel.findItemsByTransactionId(sale.id),
        PaymentModel.findByTransactionId(sale.id),
      ),
    );
    sendSuccess(res, { queued: true, to }, 202);
  }),
);

router.post(
  '/:id/void',
  asyncHandler(async (req, res) => {
    sendSuccess(res, TransactionModel.void(req.params.id));
  }),
);

router.post(
  '/:id/refund',
  authorize('admin', 'manager'),
  validateBody(refundSchema),
  asyncHandler(async (req, res) => {
    sendSuccess(res, TransactionModel.refund(req.params.id, req.body));
  }),
);

export default router;
