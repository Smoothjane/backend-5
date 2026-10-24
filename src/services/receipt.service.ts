import { config } from '@/config/config';
import type { Payment } from '@/models/payment.model';
import type { Transaction, TransactionItem } from '@/models/transaction.model';
import type { Email } from '@/services/email.service';

const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: config.store.currency }).format(
    cents / 100,
  );

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Plain-text and HTML receipt for a sale, mirroring the printed one. */
export function receiptEmail(
  to: string,
  sale: Transaction,
  items: TransactionItem[],
  payments: Payment[],
): Email {
  const lines = items.map((i) => `${i.quantity} x ${i.name}  ${money(i.lineTotalCents)}`);
  const paid = payments
    .filter((p) => p.status === 'completed')
    .map(
      (p) =>
        `${p.method.toUpperCase()}  ${money(p.amountCents)}${p.stellarTxHash ? `  (tx ${p.stellarTxHash})` : ''}`,
    );
  const text = [
    config.store.name,
    `Receipt ${sale.reference}  ${sale.createdAt} UTC`,
    '',
    ...lines,
    '',
    `Subtotal  ${money(sale.subtotalCents)}`,
    ...(sale.discountCents ? [`Discount  -${money(sale.discountCents)}`] : []),
    ...(sale.taxCents ? [`Tax  ${money(sale.taxCents)}`] : []),
    `Total  ${money(sale.totalCents)}`,
    '',
    ...paid,
    '',
    'Thank you',
  ].join('\n');
  return {
    to,
    subject: `Your receipt from ${config.store.name} (${sale.reference})`,
    text,
    html: `<pre style="font-family:ui-monospace,monospace;font-size:14px">${escape(text)}</pre>`,
  };
}
