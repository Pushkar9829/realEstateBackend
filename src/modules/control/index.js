// Control Center adapter (control-center/docs/CC_CONTRACT.md).
//
//   mount(app)  call in app.js before the JSON body parser. When CC_KEY_ID and
//               CC_SECRET are not both set it does nothing at all, so the
//               platform behaves exactly as before (decision B6).
//   paused(key) kill-switch check for code paths outside HTTP (outbox dispatcher);
//               always false while the adapter is off.
//
// config.js, models.js, state.js, hmac.js, gate.js, sso.js and routes.js are the
// same in all four platforms; provider.js holds this platform's specifics.
const express = require('express');
const config = require('./config');

function enabled() { return config.read().enabled; }

function mount(app) {
  const cfg = config.read();
  if (!cfg.enabled) return false;
  const { router } = require('./routes');
  const { gate, status } = require('./gate');
  app.use('/api/cc', router);
  app.get('/api/cc-status', status);
  if (cfg.ssoEnabled) {
    const sso = require('./sso');
    app.post('/api/auth/cc-sso', express.json({ limit: '16kb' }), (req, res, next) => {
      sso.exchange(req.body || {}, req).then((data) => res.json({ success: true, data })).catch(next);
    });
  }
  app.use(gate);
  return true;
}

async function paused(key) {
  if (!enabled()) return false;
  return require('./state').isPaused(key);
}

module.exports = { mount, enabled, paused };
