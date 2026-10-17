// Loads and validates environment variables once. Every other file imports
// `env` from here instead of reading process.env directly.
// Tests never read .env (it may hold real provider keys or a production URI); tests/env.js sets what they need.
if (process.env.NODE_ENV !== 'test') require('dotenv').config();
const { z } = require('zod');

const flag = (def) => z.enum(['true', 'false']).default(def).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4102),
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  CORS_ORIGINS: z.string().default('http://localhost:5182'),
  CLIENT_URL: z.string().default('http://localhost:5182'),
  API_PUBLIC_URL: z.string().default('http://localhost:4102'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(7),
  // 32-byte key as 64 hex chars, used for AES-256-GCM field encryption (PAN, Aadhaar last digits, TOTP secret)
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'must be 64 hex characters'),
  OTP_PEPPER: z.string().min(8),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Property Platform <no-reply@example.com>'),
  SMS_PROVIDER: z.enum(['console', 'msg91', 'twilio']).default('console'),
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  STORAGE_PROVIDER: z.enum(['local', 'cloudinary']).default('local'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Geocoding for the listing map pin: Google when a key is set, else OpenStreetMap Nominatim.
  GOOGLE_MAPS_SERVER_KEY: z.string().optional(),
  GEOCODER_PROVIDER: z.enum(['google', 'nominatim', 'none']).default('nominatim'),

  // WhatsApp: wa.me click-to-chat needs no keys; the Cloud API (M7) does.
  WHATSAPP_PROVIDER: z.enum(['console', 'meta']).default('console'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'), // Meta Graph API version

  // Masked calling (Phase 2, Exotel)
  TELEPHONY_PROVIDER: z.enum(['none', 'exotel']).default('none'),
  EXOTEL_SID: z.string().optional(),
  EXOTEL_API_KEY: z.string().optional(),
  EXOTEL_API_TOKEN: z.string().optional(),
  EXOTEL_WEBHOOK_SECRET: z.string().optional(),

  MLM_ENGINE_URL: z.string().optional(),
  MLM_PLATFORM_KEY: z.string().optional(),
  MLM_PLATFORM_SECRET: z.string().optional(),

  // Demo / client-preview deployments only: every emailed or SMS one-time code is this
  // fixed 6-digit value (e.g. 123456), so testers can log in without an SMS/email provider.
  // Leave unset for a real launch. Authenticator-app (TOTP) codes are not affected.
  DEMO_OTP_CODE: z.string().regex(/^\d{6}$/, 'must be 6 digits').optional().or(z.literal('').transform(() => undefined)),

  JOBS_ENABLED: flag('true'),
  JOBS_POLL_MS: z.coerce.number().default(5000),
  SEED_ADMIN_EMAIL: z.string().email().default('superadmin@example.com'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe@123'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;
env.isProd = env.NODE_ENV === 'production';
env.isTest = env.NODE_ENV === 'test';
env.corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

if (env.DEMO_OTP_CODE) console.warn('[env] DEMO_OTP_CODE is set: every one-time code is the fixed demo code. Remove it before a real launch.');
if (env.isProd && env.STORAGE_PROVIDER === 'local') console.warn('[env] STORAGE_PROVIDER=local in production (Render disk is ephemeral)');

module.exports = env;
