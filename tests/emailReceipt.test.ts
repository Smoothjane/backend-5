import * as email from '@/services/email.service';
import { receiptEmail } from '@/services/receipt.service';
import { setupQueues } from '@/utils/queue';
import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();
beforeAll(() => setupQueues());

describe('POST /transactions/:id/receipt/email', () => {
  let token: string;
  let saleId: string;
  beforeAll(async () => {
    token = (await signUp()).token;
    const p = await createProduct(token, { name: 'Flat White', priceCents: 420 });
    const customer = await api()
      .post('/api/v1/customers')
      .set(bearer(token))
      .send({ name: 'Amaka', email: 'amaka@example.com' });
    saleId = (
      await createSale(token, [{ productId: p.id, quantity: 2 }], {
        customerId: customer.body.data.id,
      })
    ).id;
  });

  it('refuses unpaid sales', async () => {
    await api()
      .post(`/api/v1/transactions/${saleId}/receipt/email`)
      .set(bearer(token))
      .send({})
      .expect(409);
  });

  it("queues the receipt to the customer's email, or an explicit address", async () => {
    await api()
      .post('/api/v1/payments')
      .set(bearer(token))
      .send({ transactionId: saleId, method: 'card' })
      .expect(201);
    const queue = jest.spyOn(email, 'queueEmail').mockImplementation(() => undefined);

    const res = await api()
      .post(`/api/v1/transactions/${saleId}/receipt/email`)
      .set(bearer(token))
      .send({})
      .expect(202);
    expect(res.body.data).toEqual({ queued: true, to: 'amaka@example.com' });
    expect(queue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: 'amaka@example.com',
        subject: expect.stringContaining('S-000001'),
      }),
    );

    await api()
      .post(`/api/v1/transactions/${saleId}/receipt/email`)
      .set(bearer(token))
      .send({ email: 'OTHER@example.com' })
      .expect(202);
    expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({ to: 'other@example.com' }));
    await api()
      .post(`/api/v1/transactions/${saleId}/receipt/email`)
      .set(bearer(token))
      .send({ email: 'not-an-email' })
      .expect(400);
  });
});

describe('receipt content', () => {
  it('lists items and totals, and escapes HTML', () => {
    const e = receiptEmail(
      'a@b.co',
      {
        reference: 'S-000009',
        createdAt: '2026-10-24 10:00:00',
        subtotalCents: 840,
        discountCents: 0,
        taxCents: 0,
        totalCents: 840,
      } as never,
      [{ name: '<b>Flat</b> White', quantity: 2, lineTotalCents: 840 } as never],
      [{ method: 'stellar', amountCents: 840, status: 'completed', stellarTxHash: 'abc' } as never],
    );
    expect(e.text).toContain('2 x <b>Flat</b> White  $8.40');
    expect(e.text).toContain('STELLAR  $8.40  (tx abc)');
    expect(e.html).toContain('&lt;b&gt;Flat&lt;/b&gt;');
  });
});

describe('sendEmail via Resend', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_API_KEY;
  });

  it('posts to the Resend API and throws on failure so the queue retries', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.EMAIL_API_KEY = 're_test';
    jest.resetModules(); // reload config with the env above
    const { sendEmail } = await import('@/services/email.service');
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }));

    await sendEmail({ to: 'a@b.co', subject: 'Hi', text: 'Body' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(init!.body))).toMatchObject({ to: ['a@b.co'], subject: 'Hi' });

    await expect(sendEmail({ to: 'a@b.co', subject: 'Hi', text: 'Body' })).rejects.toThrow(/429/);
  });
});
