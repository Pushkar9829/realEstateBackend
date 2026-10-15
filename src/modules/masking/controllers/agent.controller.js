// Module B - Identity & Contact Masking: agent panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('B', [
  'revealBuyerContactAudited', // POST /api/agent/leads/:id/reveal-contact - Reveal buyer contact (audited)
  'revealListerContactAudited', // POST /api/agent/properties/:id/reveal-contact - Reveal lister contact (audited)
]);

// ---- Phase 3: audited contact reveal (RE-B-10) ----
const { asyncHandler, ok } = require('../../../core/http');
const reveal = require('../reveal.service');

Object.assign(module.exports, {
  revealBuyerContactAudited: asyncHandler(async (req, res) => ok(res, await reveal.revealBuyer(req.params.id, req.body, req))),
  revealListerContactAudited: asyncHandler(async (req, res) => ok(res, await reveal.revealLister(req.params.id, req.body, req))),
});
