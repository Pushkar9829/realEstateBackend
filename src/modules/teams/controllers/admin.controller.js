// Module J - Teams & Territory Management: admin panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');
const { asyncHandler, ok, created } = require('../../../core/http');
const v = require('../../auth/validators');
const staff = require('../../auth/services/staff.service');

module.exports = stubs('J', [
  'list', // GET /api/admin/teams - List
  'create', // POST /api/admin/teams - Create
  'edit', // PATCH /api/admin/teams/:id - Edit
  'deleteNoOpenLeads', // DELETE /api/admin/teams/:id - Delete (no open leads)
  'capacityAvailability', // PATCH /api/admin/teams/:id/members/:agentId - Capacity, availability
  'listGet', // GET /api/admin/routing-rules - List
  'createPost', // POST /api/admin/routing-rules - Create
  'reorder', // PATCH /api/admin/routing-rules/reorder - Reorder
  'simulate', // POST /api/admin/routing-rules/simulate - Simulate
  'editPatch', // PATCH /api/admin/routing-rules/:id - Edit
  'delete', // DELETE /api/admin/routing-rules/:id - Delete
  // 'list2' implemented below (Phase 1, staff provisioning)
  // 'list2', // GET /api/admin/staff - List
  // 'create2' implemented below (Phase 1, staff provisioning)
  // 'create2', // POST /api/admin/staff - Create
  // 'edit2' implemented below (Phase 1, staff provisioning)
  // 'edit2', // PATCH /api/admin/staff/:id - Edit
  // 'disableWithReassignment' implemented below (Phase 1, staff provisioning)
  // 'disableWithReassignment', // POST /api/admin/staff/:id/disable - Disable with reassignment
  // 'reset2fa' implemented below (Phase 1, staff provisioning)
  // 'reset2fa', // POST /api/admin/staff/:id/reset-2fa - Reset 2FA
  // 'revokeSessions' implemented below (Phase 1, staff provisioning)
  // 'revokeSessions', // POST /api/admin/staff/:id/force-logout - Revoke sessions
]);

// RE-M-08 staff provisioning (Phase 1)
Object.assign(module.exports, {
  list2: asyncHandler(async (req, res) => { const { items, meta } = await staff.list(req.query); ok(res, items, meta); }), // GET /api/admin/staff
  create2: asyncHandler(async (req, res) => created(res, await staff.create(v.staffCreate.parse(req.body), req))), // POST /api/admin/staff
  edit2: asyncHandler(async (req, res) => ok(res, await staff.edit(req.params.id, v.staffEdit.parse(req.body), req))), // PATCH /api/admin/staff/:id
  disableWithReassignment: asyncHandler(async (req, res) => ok(res, await staff.disable(req.params.id, v.staffDisable.parse(req.body), req))), // POST /api/admin/staff/:id/disable
  enableStaff: asyncHandler(async (req, res) => ok(res, await staff.enable(req.params.id, req))), // POST /api/admin/staff/:id/enable
  reset2fa: asyncHandler(async (req, res) => ok(res, await staff.reset2fa(req.params.id, req))), // POST /api/admin/staff/:id/reset-2fa
  revokeSessions: asyncHandler(async (req, res) => ok(res, await staff.forceLogout(req.params.id, req))), // POST /api/admin/staff/:id/force-logout
});

// ---- Phase 4: teams and routing rules (spec 4.10) ----
const teamsSvc = require('../service');
const { asyncHandler: handler, ok: send } = require('../../../core/http');

const one = (fn, status = 200) => handler(async (req, res) => (status === 201 ? res.status(201).json({ success: true, data: await fn(req) }) : send(res, await fn(req))));

Object.assign(module.exports, {
  list: one((req) => teamsSvc.listTeams(req.user)),
  create: one((req) => teamsSvc.createTeam(req.body, req), 201),
  edit: one((req) => teamsSvc.editTeam(req.params.id, req.body, req)),
  deleteNoOpenLeads: one((req) => teamsSvc.deleteTeam(req.params.id, req)),
  capacityAvailability: one((req) => teamsSvc.patchMember(req.params.id, req.params.agentId, req.body, req.user, req)),
  listGet: one(() => teamsSvc.listRules()),
  createPost: one((req) => teamsSvc.createRule(req.body, req), 201),
  reorder: one((req) => teamsSvc.reorderRules(req.body, req)),
  simulate: one((req) => teamsSvc.simulate(req.body)),
  editPatch: one((req) => teamsSvc.editRule(req.params.id, req.body, req)),
  delete: one((req) => teamsSvc.deleteRule(req.params.id, req)),
});
