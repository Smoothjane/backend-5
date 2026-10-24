import Joi from 'joi';

export const createSaleSchema = Joi.object({
  customerId: Joi.string().uuid().allow(null),
  items: Joi.array()
    .items(
      Joi.object({
        productId: Joi.string().uuid().required(),
        quantity: Joi.number().integer().min(1).max(10_000).required(),
      }),
    )
    .min(1)
    .max(200)
    .required(),
  discountCents: Joi.number().integer().min(0).default(0),
  note: Joi.string().allow('').max(500),
});

export const refundSchema = Joi.object({
  restock: Joi.boolean().default(true),
  reason: Joi.string().allow('').max(300),
});

export const emailReceiptSchema = Joi.object({
  email: Joi.string().trim().lowercase().email(),
});
