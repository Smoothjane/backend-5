import { api, bearer, createProduct, signUp, useDatabase } from './helpers';

useDatabase();

describe('GET /products/catalog', () => {
  let token: string;
  beforeAll(async () => {
    token = (await signUp()).token;
    for (let i = 0; i < 3; i++) await createProduct(token, { description: 'x'.repeat(400) });
    await createProduct(token, { active: false });
  });

  it('returns every active product with only register fields', async () => {
    const res = await api().get('/api/v1/products/catalog').expect(200);
    expect(res.body.data).toHaveLength(3);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ['category', 'id', 'lowStock', 'name', 'priceCents', 'sku', 'stock'].sort(),
    );
  });

  it('is much smaller than the full listing', async () => {
    const full = await api().get('/api/v1/products').expect(200);
    const compact = await api().get('/api/v1/products/catalog').expect(200);
    expect(compact.text.length).toBeLessThan(full.text.length / 2);
  });

  it('answers 304 when the client already has the current catalog', async () => {
    const first = await api().get('/api/v1/products/catalog').expect(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    await api().get('/api/v1/products/catalog').set('If-None-Match', etag).expect(304);

    const p = (await api().get('/api/v1/products/catalog')).body.data[0];
    await api()
      .put(`/api/v1/products/${p.id}`)
      .set(bearer(token))
      .send({ priceCents: 999 })
      .expect(200);
    await api().get('/api/v1/products/catalog').set('If-None-Match', etag).expect(200);
  });
});
