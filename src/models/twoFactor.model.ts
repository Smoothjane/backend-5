import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '@/utils/database';
import { open, seal } from '@/utils/secretBox';

interface Row {
  user_id: string;
  secret_enc: string | null;
  pending_enc: string | null;
  recovery_hashes: string;
  last_step: number;
  enabled_at: string | null;
}

const hash = (code: string) =>
  createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');

/** 8 one-time recovery codes like "K7QP-2M9X", shown once at enrolment. */
function newRecoveryCodes(): string[] {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => {
    const b = randomBytes(8);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

const row = (userId: string) =>
  getDb().prepare('SELECT * FROM user_totp WHERE user_id = ?').get(userId) as Row | undefined;

export const TwoFactorModel = {
  isEnabled(userId: string): boolean {
    return Boolean(row(userId)?.secret_enc);
  },

  secret(userId: string): string | null {
    const r = row(userId);
    return r?.secret_enc ? open(r.secret_enc) : null;
  },

  pending(userId: string): string | null {
    const r = row(userId);
    return r?.pending_enc ? open(r.pending_enc) : null;
  },

  lastStep(userId: string): number {
    return row(userId)?.last_step ?? 0;
  },

  setPending(userId: string, secret: string): void {
    getDb()
      .prepare(
        `INSERT INTO user_totp (user_id, pending_enc) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET pending_enc = excluded.pending_enc`,
      )
      .run(userId, seal(secret));
  },

  /** Promotes the pending secret and returns fresh recovery codes (plain, shown once). */
  enable(userId: string, step: number): string[] {
    const r = row(userId);
    if (!r?.pending_enc) throw new Error('No pending 2FA setup');
    const codes = newRecoveryCodes();
    getDb()
      .prepare(
        `UPDATE user_totp SET secret_enc = pending_enc, pending_enc = NULL, last_step = ?,
           recovery_hashes = ?, enabled_at = datetime('now') WHERE user_id = ?`,
      )
      .run(step, JSON.stringify(codes.map(hash)), userId);
    return codes;
  },

  disable(userId: string): void {
    getDb().prepare('DELETE FROM user_totp WHERE user_id = ?').run(userId);
  },

  /** Records a used time step; false if it (or a later one) was already used. */
  consumeStep(userId: string, step: number): boolean {
    return (
      getDb()
        .prepare('UPDATE user_totp SET last_step = ? WHERE user_id = ? AND last_step < ?')
        .run(step, userId, step).changes === 1
    );
  },

  /** Uses up a recovery code; true if it was valid and unused. */
  consumeRecoveryCode(userId: string, code: string): boolean {
    const r = row(userId);
    if (!r) return false;
    const hashes: string[] = JSON.parse(r.recovery_hashes);
    const i = hashes.indexOf(hash(code));
    if (i === -1) return false;
    hashes.splice(i, 1);
    getDb()
      .prepare('UPDATE user_totp SET recovery_hashes = ? WHERE user_id = ?')
      .run(JSON.stringify(hashes), userId);
    return true;
  },

  recoveryCodesLeft(userId: string): number {
    const r = row(userId);
    return r ? (JSON.parse(r.recovery_hashes) as string[]).length : 0;
  },
};
