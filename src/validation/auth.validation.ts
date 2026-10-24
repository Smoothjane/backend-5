import Joi from 'joi';
import { ROLES } from '@/models/user.model';

const password = Joi.string().min(8).max(128);

export const registerSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  email: Joi.string().trim().lowercase().email().required(),
  password: password.required(),
});

export const loginSchema = Joi.object({
  email: Joi.string().trim().lowercase().email().required(),
  password: Joi.string().required(),
});

export const createStaffSchema = registerSchema.keys({
  role: Joi.string()
    .valid(...ROLES)
    .default('cashier'),
});

export const updateRoleSchema = Joi.object({
  role: Joi.string()
    .valid(...ROLES)
    .required(),
});

export const updateProfileSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100),
  currentPassword: Joi.string(),
  newPassword: password,
})
  .with('newPassword', 'currentPassword')
  .min(1);

const otp = Joi.string().trim().min(6).max(12).required();

export const totpCodeSchema = Joi.object({ code: otp });

export const disableTwoFactorSchema = Joi.object({
  password: Joi.string().required(),
  code: otp,
});

export const verifyTwoFactorSchema = Joi.object({
  challenge: Joi.string().required(),
  code: otp,
});
