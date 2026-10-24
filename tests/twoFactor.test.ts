import { getDb } from '@/utils/database';
import { codeForStep, stepAt } from '@/utils/totp';
import { api, bearer, useDatabase } from './helpers';

useDatabase();

const EMAIL = 'owner2fa@example.com';
const PASSWORD = 'correct-horse-1';

/** A valid code for "now" that has not been used yet (next step avoids replays). */
const codeAt = (secret: string, offsetSteps = 0) =>
  codeForStep(secret, stepAt(Date.now()) + offsetSteps);

describe('two-factor sign-in', () => {
  let token: string;
  let secret: string;
  let recovery: string[];

  beforeAll(async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Owner', email: EMAIL, password: PASSWORD });
    token = res.body.data.token;
  });

  it('is off by default', async () => {
    const me = await api().get('/api/v1/auth/me').set(bearer(token)).expect(200);
    expect(me.body.data.twoFactorEnabled).toBe(false);
  });

  it('enrols only after a correct code', async () => {
    const setup = await api().post('/api/v1/auth/2fa/setup').set(bearer(token)).expect(200);
    secret = setup.body.data.secret;
    expect(setup.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);

    await api()
      .post('/api/v1/auth/2fa/enable')
      .set(bearer(token))
      .send({ code: '000000' })
      .expect(400);
    const ok = await api()
      .post('/api/v1/auth/2fa/enable')
      .set(bearer(token))
      .send({ code: codeAt(secret) })
      .expect(200);
    recovery = ok.body.data.recoveryCodes;
    expect(recovery).toHaveLength(8);
    expect(recovery[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('stores the secret encrypted and recovery codes hashed', () => {
    const row = getDb().prepare('SELECT secret_enc, recovery_hashes FROM user_totp').get() as {
      secret_enc: string;
      recovery_hashes: string;
    };
    expect(row.secret_enc).not.toContain(secret);
    expect(row.recovery_hashes).not.toContain(recovery[0]);
  });

  it('turns login into a two-step flow', async () => {
    const step1 = await api()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    expect(step1.body.data).toEqual({ twoFactorRequired: true, challenge: expect.any(String) });
    expect(step1.body.data.token).toBeUndefined();

    const { challenge } = step1.body.data;
    await api().post('/api/v1/auth/2fa/verify').send({ challenge, code: '123456' }).expect(401);
    const step2 = await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challenge, code: codeAt(secret, 1) })
      .expect(200);
    expect(step2.body.data.token).toEqual(expect.any(String));
    expect(step2.body.data.user.twoFactorEnabled).toBe(true);
  });

  it('rejects a code that was already used (replay)', async () => {
    const { challenge } = (
      await api().post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD })
    ).body.data;
    await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challenge, code: codeAt(secret, 1) })
      .expect(401);
  });

  it('accepts each recovery code once', async () => {
    const login = () => api().post('/api/v1/auth/login').send({ email: EMAIL, password: PASSWORD });
    const { challenge } = (await login()).body.data;
    await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challenge, code: recovery[0].toLowerCase() })
      .expect(200);
    const again = (await login()).body.data.challenge;
    await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challenge: again, code: recovery[0] })
      .expect(401);
    const status = await api().get('/api/v1/auth/2fa').set(bearer(token)).expect(200);
    expect(status.body.data).toEqual({ enabled: true, recoveryCodesLeft: 7 });
  });

  it('refuses forged or expired challenges', async () => {
    await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challenge: token, code: codeAt(secret) })
      .expect(401);
    await api()
      .post('/api/v1/auth/2fa/verify')
      .send({ challenge: 'garbage', code: codeAt(secret) })
      .expect(401);
  });

  it('needs the password and a code to turn off', async () => {
    await api()
      .post('/api/v1/auth/2fa/disable')
      .set(bearer(token))
      .send({ password: 'wrong-password', code: recovery[1] })
      .expect(401);
    await api()
      .post('/api/v1/auth/2fa/disable')
      .set(bearer(token))
      .send({ password: PASSWORD, code: recovery[1] })
      .expect(200);
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);
    expect(login.body.data.token).toEqual(expect.any(String));
  });
});
