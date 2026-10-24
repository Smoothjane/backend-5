import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '@/config/config';

/**
 * AES-256-GCM encryption for small secrets stored in the database (2FA
 * seeds), so a copied database file alone does not reveal them. The key is
 * derived from JWT_SECRET; rotating JWT_SECRET therefore requires users to
 * re-enrol 2FA.
 */
const key = () => createHash('sha256').update(`stellarpos:secretbox:${config.jwt.secret}`).digest();

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function open(sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
