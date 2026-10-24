import { toFtsQuery } from '@/utils/searchIndex';
import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();

describe('toFtsQuery', () => {
  it('turns words into quoted prefix terms', () => {
    expect(toFtsQuery('flat wh')).toBe('"flat"* "wh"*');
  });

  it('neutralises FTS5 syntax in user input', () => {
    expect(toFtsQuery('NEAR(a b) OR title:x*')).toBe('"NEAR"* "a"* "b"* "OR"* "title"* "x"*');
    expect(toFtsQuery('  "" ** ')).toBeNull();
  });
});

describe('GET /search', () => {
  let token: string;
  beforeAll(async () => {
    token = (await signUp()).token;
    await createProduct(token, { name: 'Flat White', sku: 'COF-FLW', category: 'Coffee' });
    await createProduct(token, { name: 'Café Latté', sku: 'COF-LAT', category: 'Coffee' });
    const croissant = await createProduct(token, {
      name: 'Butter Croissant',
      sku: 'BAK-CRO',
      category: 'Bakery',
    });
    await api()
      .post('/api/v1/customers')
      .set(bearer(token))
      .send({ name: 'Amaka Obi', email: 'amaka@example.com', notes: 'Loves croissants' })
      .expect(201);
    await createSale(token, [{ productId: croissant.id, quantity: 2 }], { note: 'Birthday order' });
  });

  const search = async (q: string, extra = '') =>
    (
      await api()
        .get(`/api/v1/search?q=${encodeURIComponent(q)}${extra}`)
        .set(bearer(token))
        .expect(200)
    ).body.data as { kind: string; title: string; snippet: string }[];

  it('matches prefixes in any order', async () => {
    expect((await search('wh flat')).map((h) => h.title)).toEqual(['Flat White']);
  });

  it('ignores accents', async () => {
    const hits = await search('cafe latte');
    expect(hits[0]).toMatchObject({ kind: 'product', title: 'Café Latté' });
  });

  it('finds sales by item, note or reference, once each', async () => {
    const byItem = await search('croissant', '&types=sale');
    expect(byItem).toHaveLength(1);
    expect(byItem[0].title).toMatch(/^S-\d{6}$/);
    expect((await search('birthday', '&types=sale'))[0].title).toBe(byItem[0].title);
    expect(await search(byItem[0].title, '&types=sale')).toHaveLength(1);
  });

  it('searches across kinds and highlights matches', async () => {
    const hits = await search('croissant');
    expect(new Set(hits.map((h) => h.kind))).toEqual(new Set(['product', 'customer', 'sale']));
    expect(hits.find((h) => h.kind === 'customer')!.snippet).toContain('[[croissants]]');
  });

  it('keeps the index in sync with updates and deletes', async () => {
    const p = await createProduct(token, { name: 'Zobo Drink', sku: 'BEV-ZOB' });
    await api()
      .put(`/api/v1/products/${p.id}`)
      .set(bearer(token))
      .send({ name: 'Hibiscus Zobo' })
      .expect(200);
    expect((await search('hibiscus')).map((h) => h.title)).toContain('Hibiscus Zobo');
    await api().delete(`/api/v1/products/${p.id}`).set(bearer(token)).expect(200);
    expect(await search('hibiscus')).toEqual([]);
  });

  it('validates input and requires auth', async () => {
    await api().get('/api/v1/search?q=%20').set(bearer(token)).expect(400);
    await api().get('/api/v1/search?q=x&types=nope').set(bearer(token)).expect(400);
    await api().get('/api/v1/search?q=x').expect(401);
  });
});

describe('backfill', () => {
  it('indexes existing rows when the index is empty (upgrade path)', async () => {
    const { getDb } = await import('@/utils/database');
    const { backfillSearchIndex } = await import('@/utils/searchIndex');
    const db = getDb();
    db.exec('DELETE FROM search_index');
    expect(db.prepare('SELECT COUNT(*) AS n FROM search_index').get()).toEqual({ n: 0 });
    backfillSearchIndex(db);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM search_index').get() as { n: number }).n;
    expect(n).toBeGreaterThan(0);
    // Running it again on a populated index changes nothing.
    backfillSearchIndex(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM search_index').get() as { n: number }).n).toBe(n);
  });
});
