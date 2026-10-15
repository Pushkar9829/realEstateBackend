// Module O - Reports, Audit & System Logs: public panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('O', [
  'dbStatusAndVersion', // GET /api/health - DB status and version
]);

// ---- Phase 1: health ----
const { ok } = require('../../../core/http');
const { dbState } = require('../../../config/db');
const pkg = require('../../../../package.json');

Object.assign(module.exports, {
  // GET /api/health (also answered by app.js before rate limits; kept for the route map)
  dbStatusAndVersion: (req, res) => ok(res, { status: dbState() === 'up' ? 'ok' : 'degraded', db: dbState(), version: pkg.version, time: new Date().toISOString() }),
});
