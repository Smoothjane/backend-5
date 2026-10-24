import { sanitizeDeep, sanitizeText } from '@/utils/sanitize';
import { api, bearer, signUp, useDatabase } from './helpers';

describe('sanitizeText', () => {
  it.each([
    ['<script>alert(1)</script>Flat White', 'Flat White'],
    ['<img src=x onerror=alert(1)>Tea', 'Tea'],
    ['<b>Bold</b> Brew', 'Bold Brew'],
    ['click javascript:alert(1)', 'click alert(1)'],
    ['Tab\tand\nnewline\u0000\u0007', 'Tab\tand\nnewline'],
    ['Fish & chips < 5 for 2 > 1', 'Fish & chips < 5 for 2 > 1'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });

  it('walks nested objects and arrays and keeps other types', () => {
    expect(sanitizeDeep({ a: '<i>x</i>', b: [1, '<u>y</u>'], c: true, d: null })).toEqual({
      a: 'x',
      b: [1, 'y'],
      c: true,
      d: null,
    });
  });
});

describe('API input sanitizing', () => {
  useDatabase();

  it('strips markup from stored text', async () => {
    const { token } = await signUp();
    const res = await api()
      .post('/api/v1/customers')
      .set(bearer(token))
      .send({ name: '<script>steal()</script>Amaka', notes: '<a href="javascript:x">VIP</a>' })
      .expect(201);
    expect(res.body.data).toMatchObject({ name: 'Amaka', notes: 'VIP' });
  });

  it('never alters passwords', async () => {
    const pw = '<b>pa$$word</b>';
    await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Tag Lover', email: 'tags@example.com', password: pw })
      .expect(201);
    await api()
      .post('/api/v1/auth/login')
      .send({ email: 'tags@example.com', password: pw })
      .expect(200);
  });
});
