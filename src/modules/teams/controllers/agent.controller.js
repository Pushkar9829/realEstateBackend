// Module J - Teams & Territory Management: agent panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('J', [
  'availabilityLeave', // PATCH /api/agent/availability - Availability / leave
]);

// ---- Phase 4: agent availability and leave (RE-J-05) ----
const { asyncHandler, ok } = require('../../../core/http');
const teamsSvc = require('../service');

Object.assign(module.exports, {
  availabilityLeave: asyncHandler(async (req, res) => ok(res, await teamsSvc.setOwnAvailability(req.user, req.body, req))),
  // GET /api/agent/availability - null when the agent is not in a team yet
  myAvailability: asyncHandler(async (req, res) => ok(res, await teamsSvc.myTeam(req.user))),
});
