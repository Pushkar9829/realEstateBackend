// Panel composition: every module contributes one router per panel it serves
// (module.routes.<panel>). Each panel is mounted once with its own guard, so
// module routes only add finer checks (permissions, builder-only, tokens).
//
//   integrations  /api           provider webhooks (WhatsApp, telephony), before body parsing
//   public        /api           guests, buyers, shared account endpoints (/auth, /me, /uploads)
//   lister        /api/lister    role = lister
//   agent         /api/agent     role = agent | manager
//   admin         /api/admin     role = admin | superadmin | manager (+ permission keys)
const express = require('express');
const modules = require('../modules');
const { authenticate, requireRole } = require('../core/middleware/auth');
const { ROLES, ADMIN_PANEL_ROLES } = require('../constants/roles');
const ApiError = require('../core/http/ApiError');

// Suspended or banned listers keep read access to their dashboard and invoices
// only (spec 4.13); everything else on the lister panel answers 423.
const listerNotSuspended = (req, res, next) => {
  const status = req.user.kyc && req.user.kyc.status;
  if (['suspended', 'banned'].includes(status) && !/^\/(dashboard|invoices)(\/|$)/.test(req.path)) {
    return next(new ApiError(423, 'LISTER_SUSPENDED', `Your lister account is ${status}. Contact support.`));
  }
  return next();
};

const PANELS = {
  integrations: { mount: '/api', guard: [] },
  public: { mount: '/api', guard: [] },
  lister: { mount: '/api/lister', guard: [authenticate, requireRole(ROLES.LISTER), listerNotSuspended] },
  agent: { mount: '/api/agent', guard: [authenticate, requireRole(ROLES.AGENT, ROLES.MANAGER)] },
  admin: { mount: '/api/admin', guard: [authenticate, requireRole(...ADMIN_PANEL_ROLES)] },
};

function buildPanel(name) {
  const router = express.Router();
  if (PANELS[name].guard.length) router.use(...PANELS[name].guard);
  modules.forEach((m) => { if (m.routes && m.routes[name]) router.use(m.routes[name]); });
  return router;
}

module.exports = { PANELS, buildPanel };
