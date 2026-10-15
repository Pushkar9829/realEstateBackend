// Module B - Identity & Contact Masking: admin panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('B', [
  'revealAudit', // GET /api/admin/contact-reveals - Reveal audit
]);

// ---- Phase 3: reveal audit (RE-B-10) ----
const { asyncHandler: ah, ok: okRes } = require('../../../core/http');
const revealSvc = require('../reveal.service');

Object.assign(module.exports, {
  revealAudit: ah(async (req, res) => { const { items, meta } = await revealSvc.listReveals(req.query); okRes(res, items, meta); }),
});
