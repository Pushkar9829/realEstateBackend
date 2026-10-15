// Rate limits use express-rate-limit's in-memory store (no Redis). Limits are
// per Render instance; that is acceptable for a single-instance deployment.
const rateLimit = require('express-rate-limit');
const env = require('../../config/env');

const make = (windowMs, limit, code = 'RATE_LIMITED') => rateLimit({
  windowMs,
  limit: env.isTest ? 10000 : limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, error: { code, message: 'Too many requests, please try again later' } }),
});

module.exports = {
  global: make(60 * 1000, 300),            // all /api traffic per IP
  auth: make(15 * 60 * 1000, 30),          // login, register, password reset
  otp: make(60 * 60 * 1000, 10, 'OTP_RATE_LIMITED'), // OTP sends per IP per hour
  webhook: make(60 * 1000, 600),           // provider callbacks
  locationPing: make(60 * 1000, 10),       // delivery partner pings
};
