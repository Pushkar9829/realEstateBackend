// Express application (exported without listening, for tests).
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');

const env = require('./config/env');
const logger = require('./core/logger');
const { dbState } = require('./config/db');
const limits = require('./core/middleware/rateLimits');
const { notFound, errorHandler } = require('./core/middleware/errors');
const { PANELS, buildPanel } = require('./panels');
const pkg = require('../package.json');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render terminates TLS in front of the app
  app.disable('x-powered-by');

  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
    autoLogging: { ignore: (req) => req.url === '/api/health' },
  }));
  app.use((req, res, next) => { res.setHeader('X-Request-Id', req.id); next(); });
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  }));
  app.use(compression());

  // Health check (Render) - before rate limits
  app.get('/api/health', (req, res) => res.json({
    success: true,
    data: { status: dbState() === 'up' ? 'ok' : 'degraded', db: dbState(), version: pkg.version, env: env.NODE_ENV, time: new Date().toISOString() },
  }));

  app.use('/api', limits.global);

  // Provider webhooks need the raw body, so they mount before the JSON parser.
  app.use(PANELS.integrations.mount, buildPanel('integrations'));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(mongoSanitize());

  // Local storage provider serves files in development only.
  if (env.STORAGE_PROVIDER === 'local') app.use('/uploads', express.static(path.resolve(process.cwd(), 'uploads'), { maxAge: '1h' }));

  // Panel routers (more specific mounts first).
  ['lister', 'agent', 'admin', 'public'].forEach((name) => app.use(PANELS[name].mount, buildPanel(name)));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
