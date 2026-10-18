// Request gate (only mounted when the adapter is on): maintenance mode and kill switches.
//   maintenance on -> POST/PUT/PATCH/DELETE under /api answer 503 MAINTENANCE, except
//                     /api/auth/*, /api/cc/*, the admin API and admin-role tokens
//   flag paused    -> the flag's method + path rules answer 423 PAUSED_BY_CONTROL_CENTER
const state = require('./state');
const provider = require('./provider');

const { ApiError } = provider;
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function matches(rule, req, path) {
  return (!rule.method || rule.method === req.method) && rule.path.test(path);
}

async function gate(req, res, next) {
  try {
    const path = req.originalUrl.split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/cc/') || path === '/api/cc-status') return next();
    const s = await state.get();
    for (const flag of provider.flags) {
      if (s.flags[flag.key] && s.flags[flag.key].paused && (flag.rules || []).some((r) => matches(r, req, path))) {
        return next(new ApiError(423, 'PAUSED_BY_CONTROL_CENTER', `${flag.label} is paused for now. Please try again later.`, { flag: flag.key }));
      }
    }
    if (s.maintenance && s.maintenance.on && WRITE.has(req.method)) {
      const exempt = path.startsWith('/api/auth/') || provider.adminApiPrefixes.some((p) => path.startsWith(p)) || (await provider.isAdminRequest(req));
      if (!exempt) {
        return next(new ApiError(503, 'MAINTENANCE', s.maintenance.message || 'We are doing some maintenance. Changes are paused for a short while.'));
      }
    }
    return next();
  } catch (e) { return next(e); }
}

async function status(req, res, next) {
  try {
    const s = await state.get();
    res.json({ success: true, data: { maintenance: { on: Boolean(s.maintenance && s.maintenance.on), message: (s.maintenance && s.maintenance.on && s.maintenance.message) || null } } });
  } catch (e) { next(e); }
}

module.exports = { gate, status };
