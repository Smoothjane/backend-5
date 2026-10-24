import bcrypt from 'bcryptjs';
import type { Request, Response } from 'express';
import { AppError, conflict, notFound } from '@/middleware/error.middleware';
import { signToken } from '@/middleware/auth.middleware';
import { toPublicUser, UserModel, type Role, type User } from '@/models/user.model';
import { sendSuccess } from '@/utils/helpers';
import * as twoFactor from '@/controllers/twoFactor.controller';
import { issueChallenge } from '@/controllers/twoFactor.controller';
import { TwoFactorModel } from '@/models/twoFactor.model';

const SALT_ROUNDS = 10;

const publicUser = (user: User) => ({
  ...toPublicUser(user),
  twoFactorEnabled: TwoFactorModel.isEnabled(user.id),
});

const session = (user: User) => ({
  user: publicUser(user),
  token: signToken({ sub: user.id, email: user.email, role: user.role }),
});

/**
 * Self-service registration. The very first account becomes the store admin;
 * after that, registration creates cashiers, and admins promote staff from
 * the users endpoints.
 */
export async function register(req: Request, res: Response): Promise<void> {
  const { name, email, password } = req.body as { name: string; email: string; password: string };
  if (UserModel.findByEmail(email)) throw conflict('An account with that email already exists');
  const role: Role = UserModel.count() === 0 ? 'admin' : 'cashier';
  const user = UserModel.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
    role,
  });
  sendSuccess(res, session(user), 201);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };
  const user = UserModel.findByEmail(email);
  // Same message either way so the response does not reveal which emails exist.
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !ok) throw new AppError('Invalid email or password', 401);
  if (TwoFactorModel.isEnabled(user.id)) {
    // No session yet: the client sends a code with this challenge to /2fa/verify.
    sendSuccess(res, { twoFactorRequired: true, challenge: issueChallenge(user.id) });
    return;
  }
  sendSuccess(res, session(user));
}

export async function verifyTwoFactor(req: Request, res: Response): Promise<void> {
  await twoFactor.verifyLogin(req, res, (userId) => {
    const user = UserModel.findById(userId);
    if (!user) throw new AppError('Account no longer exists', 401);
    return session(user);
  });
}

export async function me(req: Request, res: Response): Promise<void> {
  const user = UserModel.findById(req.user!.sub);
  if (!user) throw notFound('User');
  sendSuccess(res, publicUser(user));
}

/**
 * Issues a fresh token for a still-valid session, so a till that stays open
 * all day does not sign the cashier out mid-shift. The new token carries the
 * user's current role, so role changes take effect on the next refresh.
 */
export async function refresh(req: Request, res: Response): Promise<void> {
  const user = UserModel.findById(req.user!.sub);
  if (!user) throw new AppError('Account no longer exists', 401);
  sendSuccess(res, session(user));
}

export async function updateMe(req: Request, res: Response): Promise<void> {
  const user = UserModel.findById(req.user!.sub);
  if (!user) throw notFound('User');
  const { name, currentPassword, newPassword } = req.body as {
    name?: string;
    currentPassword?: string;
    newPassword?: string;
  };
  let passwordHash: string | undefined;
  if (newPassword) {
    if (!(await bcrypt.compare(currentPassword ?? '', user.passwordHash))) {
      throw new AppError('Current password is incorrect', 400);
    }
    passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  }
  UserModel.updateProfile(user.id, { name, passwordHash });
  sendSuccess(res, toPublicUser(UserModel.findById(user.id)!));
}

export async function createStaff(req: Request, res: Response): Promise<void> {
  const { name, email, password, role } = req.body as {
    name: string;
    email: string;
    password: string;
    role: Role;
  };
  if (UserModel.findByEmail(email)) throw conflict('An account with that email already exists');
  const user = UserModel.create({
    name,
    email,
    role,
    passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
  });
  sendSuccess(res, toPublicUser(user), 201);
}

export async function listStaff(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, UserModel.list());
}

export async function updateStaffRole(req: Request, res: Response): Promise<void> {
  const target = UserModel.findById(req.params.id);
  if (!target) throw notFound('User');
  if (target.id === req.user!.sub) throw new AppError('You cannot change your own role', 400);
  UserModel.updateRole(target.id, (req.body as { role: Role }).role);
  sendSuccess(res, toPublicUser(UserModel.findById(target.id)!));
}
