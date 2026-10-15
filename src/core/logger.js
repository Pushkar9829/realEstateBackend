const pino = require('pino');

// Structured JSON logs (Render captures stdout). Secrets are redacted.
module.exports = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.otp', '*.token', '*.refreshToken'],
    censor: '[redacted]',
  },
});
