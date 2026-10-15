// Module D - Admin Approval & Operations: lister panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('D', [
  'askForASiteVisitCould', // POST /api/lister/properties/:id/verification/site-request - Ask for a site visit (Could)
  'ownAgreements', // GET /api/lister/agreements - Own agreements
  'detail', // GET /api/lister/agreements/:id - Detail
  'pdf', // GET /api/lister/agreements/:id/pdf - PDF
]);

// ---- Phase 2: lister agreements (RE-D-06) ----
const { asyncHandler, ok } = require('../../../core/http');
const agreements = require('../agreements.service');

Object.assign(module.exports, {
  ownAgreements: asyncHandler(async (req, res) => { const { items, meta } = await agreements.list(req.query, { listerId: req.user._id }); ok(res, items, meta); }),
  detail: asyncHandler(async (req, res) => ok(res, await agreements.get(req.params.id, { listerId: req.user._id }))),
  pdf: asyncHandler(async (req, res) => agreements.pdf(req.params.id, res, { listerId: req.user._id })),
});


// ---- Phase 6: lister asks for a site verification visit (RE-D-13, Could) ----
Object.assign(module.exports, {
  askForASiteVisitCould: asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await require('../site-visits.service').listerRequest(req.user, req.params.id, req.body, req) })),
});
