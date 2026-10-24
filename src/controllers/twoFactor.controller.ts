import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '@/config/config';
import { AppError, badRequest, notFound } from '@/middleware/error.middleware';
import { TwoFactorModel } from '@/models/twoFactor.model';
import { UserModel } from '@/models/user.model';
import { sendSuccess } from '@/utils/helpers';
import { generateSecret, otpauthUrl, verifyCode } from '@/utils/totp';

const CHALLENGE_TTL = '5m';

/** A short-lived token proving the password step passed, for /2fa/verify. */
export function issueChallenge(userId: string): string {
  return jwt.sign({ sub: userId, purpose: '2fa' }, config.jwt.secret, { expiresIn: CHALLENGE_TTL });
}

function readChallenge(token: string): string {
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (typeof decoded === 'string' || decoded.purpose !== '2fa' || !decoded.sub) throw new Error();
    return decoded.sub;
  } catch {
    throw new AppError('Sign-in expired, enter your password again', 401);
  }
}

/** Accepts a TOTP code (single use per 30 s step) or a recovery code. */
export function checkSecondFactor(userId: string, code: string): boolean {
  const secret = TwoFactorModel.secret(userId);
  if (!secret) return false;
  const step = verifyCode(secret, code.trim());
  if (step !== null) return TwoFactorModel.consumeStep(userId, step);
  return TwoFactorModel.consumeRecoveryCode(userId, code.trim());
}

export async function status(req: Request, res: Response): Promise<void> {
  const id = req.user!.sub;
  sendSuccess(res, {
    enabled: TwoFactorModel.isEnabled(id),
    recoveryCodesLeft: TwoFactorModel.recoveryCodesLeft(id),
  });
}

/** Starts enrolment: a new secret to scan. 2FA is not on until /enable confirms a code. */
export async function setup(req: Request, res: Response): Promise<void> {
  const user = UserModel.findById(req.user!.sub);
  if (!user) throw notFound('User');
  if (TwoFactorModel.isEnabled(user.id))
    throw new AppError('Two-factor sign-in is already on', 409);
  const secret = generateSecret();
  TwoFactorModel.setPending(user.id, secret);
  sendSuccess(res, { secret, otpauthUrl: otpauthUrl(secret, user.email, config.store.name) });
}

export async function enable(req: Request, res: Response): Promise<void> {
  const id = req.user!.sub;
  const pending = TwoFactorModel.pending(id);
  if (!pending) throw badRequest('Start setup first');
  const step = verifyCode(pending, String(req.body.code));
  if (step === null)
    throw badRequest('That code is not right. Check the time on your phone and try again.');
  sendSuccess(res, { enabled: true, recoveryCodes: TwoFactorModel.enable(id, step) });
}

export async function disable(req: Request, res: Response): Promise<void> {
  const user = UserModel.findById(req.user!.sub);
  if (!user) throw notFound('User');
  if (!TwoFactorModel.isEnabled(user.id)) throw badRequest('Two-factor sign-in is not on');
  const { password, code } = req.body as { password: string; code: string };
  const ok =
    (await bcrypt.compare(password, user.passwordHash)) && checkSecondFactor(user.id, code);
  if (!ok) throw new AppError('Password or code is incorrect', 401);
  TwoFactorModel.disable(user.id);
  sendSuccess(res, { enabled: false });
}

/** Second step of sign-in. */
export async function verifyLogin(
  req: Request,
  res: Response,
  session: (userId: string) => unknown,
): Promise<void> {
  const userId = readChallenge(String(req.body.challenge));
  if (!checkSecondFactor(userId, String(req.body.code))) {
    throw new AppError('That code is not right', 401);
  }
  sendSuccess(res, session(userId));
}
