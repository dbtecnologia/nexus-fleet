import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3333),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('15m'),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(16),
  CORS_ORIGIN: z.string().default('http://localhost:3333'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  PUBLIC_APP_URL: z.string().default('http://localhost:3333'),
});

export const config = schema.parse(process.env);
