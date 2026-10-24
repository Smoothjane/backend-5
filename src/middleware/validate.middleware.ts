import type { NextFunction, Request, Response } from 'express';
import type Joi from 'joi';
import { AppError } from '@/middleware/error.middleware';
import { sanitizeDeep } from '@/utils/sanitize';

/**
 * Validates and normalizes `req.body` against a Joi schema. Unknown keys are
 * stripped, all errors are reported together, and text is sanitized of
 * markup and control characters (passwords excepted).
 */
export const validateBody =
  (schema: Joi.ObjectSchema) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const { value, error } = schema.validate(req.body ?? {}, {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
      return next(new AppError('Validation failed', 400, true, details));
    }
    // Passwords are compared exactly, so they are never rewritten.
    const { password, currentPassword, newPassword, ...rest } = value;
    req.body = {
      ...sanitizeDeep(rest),
      ...(password !== undefined && { password }),
      ...(currentPassword !== undefined && { currentPassword }),
      ...(newPassword !== undefined && { newPassword }),
    };
    next();
  };
