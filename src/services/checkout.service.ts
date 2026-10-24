/**
 * Checkout rules: how a pending sale gets paid and completed.
 *
 * Cash and card payments are recorded directly. Stellar payments are never
 * trusted from the client: a sale is marked paid only after Horizon shows a
 * successful transaction that pays the merchant account the right asset and
 * amount (and, for QR checkouts, carries the checkout's unique memo).
 */
import { config } from '@/config/config';
import { AppError, badRequest, notFound } from '@/middleware/error.middleware';
import { PaymentModel, type Payment } from '@/models/payment.model';
import { PaymentRequestModel, type PaymentRequest } from '@/models/paymentRequest.model';
import { TransactionModel, type Transaction } from '@/models/transaction.model';
import type { IncomingPayment } from '@/services/horizon';
import * as horizon from '@/services/horizon';
import { summarize } from '@/services/analytics.service';
import { emit } from '@/services/realtime';
import {
  buildPaymentUri,
  configuredAsset,
  paymentSatisfies,
  verifyPayment,
  type Expected,
} from '@/services/stellar.service';
import { getDb, withTransaction } from '@/utils/database';
import { randomToken } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { centsToAssetAmount } from '@/utils/money';

function pendingSale(transactionId: string): Transaction {
  const sale = TransactionModel.findById(transactionId);
  if (!sale) throw notFound('Transaction');
  if (sale.status !== 'pending') {
    throw new AppError(`This sale is already ${sale.status}`, 409);
  }
  return sale;
}

function merchantAccount(): string {
  const key = config.stellar.merchantPublicKey;
  if (!key) {
    throw new AppError('Stellar payments are not configured (STELLAR_MERCHANT_PUBLIC_KEY)', 503);
  }
  return key;
}

/** Completes the sale once fully paid, and announces it. Returns the fresh sale. */
function completeIfPaid(transactionId: string): Transaction {
  const sale = TransactionModel.findById(transactionId)!;
  if (sale.status === 'pending' && sale.paidCents >= sale.totalCents) {
    TransactionModel.markCompleted(transactionId);
    const done = TransactionModel.findById(transactionId)!;
    emit('transaction:completed', done);
    // Push today's figures so open dashboards update without refetching.
    emit('analytics:updated', summarize(1));
    announceLowStock(transactionId);
    return done;
  }
  return sale;
}

function announceLowStock(transactionId: string): void {
  const low = getDb()
    .prepare(
      `SELECT p.id, p.name, p.sku, p.stock, p.low_stock_threshold AS threshold FROM products p
       WHERE p.id IN (SELECT product_id FROM transaction_items WHERE transaction_id = ?)
         AND p.stock <= p.low_stock_threshold`,
    )
    .all(transactionId);
  if (low.length) emit('inventory:low', low);
}

export function recordOfflinePayment(input: {
  transactionId: string;
  method: 'cash' | 'card';
  amountCents?: number;
  tenderedCents?: number;
}): { payment: Payment; transaction: Transaction } {
  const sale = pendingSale(input.transactionId);
  const amount = input.amountCents ?? sale.balanceCents;
  if (amount <= 0) throw badRequest('Amount must be greater than zero');
  if (amount > sale.balanceCents) {
    throw badRequest(`Amount exceeds the balance due (${sale.balanceCents} cents)`);
  }

  let tendered: number | null = null;
  let change: number | null = null;
  if (input.method === 'cash') {
    tendered = input.tenderedCents ?? amount;
    if (tendered < amount) throw badRequest('Cash tendered is less than the amount');
    change = tendered - amount;
  }

  const payment = PaymentModel.create({
    transactionId: sale.id,
    method: input.method,
    amountCents: amount,
    tenderedCents: tendered,
    changeCents: change,
    status: 'completed',
  });
  return { payment, transaction: completeIfPaid(sale.id) };
}

function expectedFor(sale: Transaction, memo?: string): Expected {
  return {
    destination: merchantAccount(),
    asset: configuredAsset(),
    amount: centsToAssetAmount(sale.balanceCents, config.stellar.assetRate),
    memo,
  };
}

/**
 * Records a Stellar payment the cashier already knows the hash of (e.g. the
 * customer paid from a wallet that shows it). The payment is verified
 * on-chain first. Failed verifications are recorded and rejected with 402.
 */
export async function recordStellarPayment(input: {
  transactionId: string;
  stellarTxHash: string;
}): Promise<{ payment: Payment; transaction: Transaction }> {
  const sale = pendingSale(input.transactionId);
  if (PaymentModel.findByStellarHash(input.stellarTxHash)) {
    throw new AppError('This Stellar transaction has already been used for a payment', 409);
  }
  const result = await verifyPayment(input.stellarTxHash, expectedFor(sale));
  if (!result.verified) {
    PaymentModel.create({
      transactionId: sale.id,
      method: 'stellar',
      amountCents: sale.balanceCents,
      status: 'failed',
    });
    throw new AppError(`Stellar payment could not be verified: ${result.reason}`, 402);
  }
  const payment = PaymentModel.create({
    transactionId: sale.id,
    method: 'stellar',
    amountCents: sale.balanceCents,
    status: 'completed',
    stellarTxHash: input.stellarTxHash,
  });
  return { payment, transaction: completeIfPaid(sale.id) };
}

/**
 * Opens a QR checkout for the sale's balance. Calling it again for the same
 * sale returns the open request instead of creating a second one.
 */
export function createPaymentRequest(transactionId: string): PaymentRequest {
  const sale = pendingSale(transactionId);
  if (sale.balanceCents <= 0) throw badRequest('Nothing left to pay on this sale');
  const open = PaymentRequestModel.findOpenForTransaction(sale.id);
  if (open && new Date(open.expiresAt) > new Date()) return open;

  const destination = merchantAccount();
  const asset = configuredAsset();
  const amount = centsToAssetAmount(sale.balanceCents, config.stellar.assetRate);
  // Text memos are capped at 28 bytes; "SP" + 10 chars is unique enough and easy to read.
  const memo = `SP${randomToken(10)}`;
  const expiresAt = new Date(Date.now() + config.stellar.paymentTtlMinutes * 60_000).toISOString();

  return PaymentRequestModel.create({
    transactionId: sale.id,
    destination,
    assetCode: asset.code,
    assetIssuer: asset.issuer,
    amount,
    memo,
    uri: buildPaymentUri({
      destination,
      amount,
      asset,
      memo,
      message: `${config.store.name} ${sale.reference}`,
    }),
    expiresAt,
  });
}

/** Marks a request paid and completes its sale. Idempotent per request. */
function settleRequest(request: PaymentRequest, txHash: string, payer: string): Transaction {
  const settled = withTransaction(() => {
    if (!PaymentRequestModel.markPaid(request.id, txHash, payer)) return false;
    const sale = TransactionModel.findById(request.transactionId)!;
    PaymentModel.create({
      transactionId: sale.id,
      method: 'stellar',
      amountCents: sale.balanceCents,
      status: 'completed',
      stellarTxHash: txHash,
    });
    return true;
  });
  const sale = completeIfPaid(request.transactionId);
  if (settled) {
    emit('payment:confirmed', {
      request: PaymentRequestModel.findById(request.id),
      transaction: sale,
    });
    logger.info(`Stellar checkout ${request.memo} settled by ${txHash}`);
  }
  return sale;
}

/** Cashier-triggered check of a QR checkout against a known transaction hash. */
export async function verifyPaymentRequest(
  requestId: string,
  txHash: string,
): Promise<{ request: PaymentRequest; transaction: Transaction }> {
  const request = PaymentRequestModel.findById(requestId);
  if (!request) throw notFound('Payment request');
  if (request.status === 'paid') {
    return { request, transaction: TransactionModel.findById(request.transactionId)! };
  }
  if (request.status !== 'pending') throw new AppError(`Payment request is ${request.status}`, 409);

  const result = await verifyPayment(txHash, {
    destination: request.destination,
    asset: { code: request.assetCode, issuer: request.assetIssuer },
    amount: request.amount,
    memo: request.memo,
  });
  if (!result.verified)
    throw new AppError(`Stellar payment could not be verified: ${result.reason}`, 402);

  const transaction = settleRequest(request, txHash, result.from ?? '');
  return { request: PaymentRequestModel.findById(requestId)!, transaction };
}

/**
 * Called by the watcher for each payment Horizon reports to the merchant
 * account. Matches it to a pending checkout by memo. Returns true when a
 * checkout was settled.
 */
export async function handleIncomingPayment(p: IncomingPayment): Promise<boolean> {
  const tx = await horizon.fetchTransaction(p.txHash);
  if (!tx?.successful || tx.memoType !== 'text' || !tx.memo) return false;

  const request = PaymentRequestModel.findPendingByMemo(tx.memo);
  if (!request) return false;

  const expected: Expected = {
    destination: request.destination,
    asset: { code: request.assetCode, issuer: request.assetIssuer },
    amount: request.amount,
  };
  if (!paymentSatisfies(p, expected)) {
    logger.warn(
      `Payment ${p.txHash} carries memo ${tx.memo} but pays ${p.amount} ${p.assetCode}; expected ${request.amount} ${request.assetCode}`,
    );
    return false;
  }
  settleRequest(request, p.txHash, p.from);
  return true;
}

export function cancelPaymentRequest(requestId: string): PaymentRequest {
  const request = PaymentRequestModel.findById(requestId);
  if (!request) throw notFound('Payment request');
  if (request.status !== 'pending') throw new AppError(`Payment request is ${request.status}`, 409);
  PaymentRequestModel.setStatus(requestId, 'cancelled');
  return PaymentRequestModel.findById(requestId)!;
}

/**
 * Expires unpaid QR checkouts. Their sale is voided and its stock released,
 * unless another payment already went towards it.
 */
export function expireStaleRequests(now = new Date()): number {
  const stale = PaymentRequestModel.listExpired(now.toISOString());
  for (const request of stale) {
    PaymentRequestModel.setStatus(request.id, 'expired');
    const sale = TransactionModel.findById(request.transactionId);
    if (sale?.status === 'pending' && sale.paidCents === 0) TransactionModel.void(sale.id);
    emit('payment:expired', PaymentRequestModel.findById(request.id));
  }
  return stale.length;
}
