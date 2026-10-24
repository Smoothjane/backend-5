import * as realtime from '@/services/realtime';
import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();

describe('analytics:updated', () => {
  it("pushes today's summary when a sale completes", async () => {
    const emit = jest.spyOn(realtime, 'emit');
    const { token } = await signUp();
    const p = await createProduct(token, { priceCents: 700 });
    const sale = await createSale(token, [{ productId: p.id, quantity: 2 }]);
    expect(emit).not.toHaveBeenCalledWith('analytics:updated', expect.anything());

    await api()
      .post('/api/v1/payments')
      .set(bearer(token))
      .send({ transactionId: sale.id, method: 'card' })
      .expect(201);

    expect(emit).toHaveBeenCalledWith(
      'analytics:updated',
      expect.objectContaining({ days: 1, totalSales: 1, totalRevenueCents: 1400, unitsSold: 2 }),
    );
    // Matches what the REST endpoint reports.
    const rest = await api().get('/api/v1/analytics/summary').set(bearer(token)).expect(200);
    const pushed = emit.mock.calls.find(([e]) => e === 'analytics:updated')![1];
    expect(pushed).toEqual(rest.body.data);
  });
});
