import { api, bearer, createProduct, signUp, useDatabase } from './helpers';

useDatabase();

describe('audit log', () => {
  let admin: { token: string; id: string };
  let cashier: { token: string; id: string };

  beforeAll(async () => {
    admin = await signUp('Owner');
    cashier = await signUp('Cashier');
  });

  const entries = async (query = '') =>
    (await api().get(`/api/v1/audit${query}`).set(bearer(admin.token)).expect(200)).body.data as {
      userId: string;
      action: string;
      path: string;
      status: number;
    }[];

  it('records successful changes with who and what', async () => {
    const product = await createProduct(admin.token);
    await api().delete(`/api/v1/products/${product.id}`).set(bearer(admin.token)).expect(200);
    const log = await entries(`?userId=${admin.id}`);
    expect(log[0]).toMatchObject({
      action: 'DELETE',
      path: `/api/v1/products/${product.id}`,
      status: 200,
    });
    expect(log[1]).toMatchObject({ action: 'POST', path: '/api/v1/products', status: 201 });
  });

  it('skips reads, failures, and credential endpoints', async () => {
    const before = (await entries()).length;
    await api().get('/api/v1/products').expect(200);
    await api().post('/api/v1/products').set(bearer(cashier.token)).send({}).expect(403);
    await api()
      .post('/api/v1/auth/login')
      .send({ email: 'x@example.com', password: 'nope-nope' })
      .expect(401);
    await signUp('Another');
    expect(await entries()).toHaveLength(before);
  });

  it('never stores request bodies', async () => {
    await api()
      .patch('/api/v1/auth/me')
      .set(bearer(cashier.token))
      .send({ name: 'Renamed' })
      .expect(200);
    expect(JSON.stringify(await entries())).not.toContain('Renamed');
  });

  it('is admin only', async () => {
    await api().get('/api/v1/audit').set(bearer(cashier.token)).expect(403);
    await api().get('/api/v1/audit').expect(401);
  });
});
