// Module E - Search & Discovery: admin panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('E', [
  'reportedListings', // GET /api/admin/listing-reports - Reported listings
  'actionAReport', // PATCH /api/admin/listing-reports/:id - Action a report
]);

// ---- Phase 3: reported listings (RE-E-13) ----
const { asyncHandler, ok } = require('../../../core/http');
const search = require('../service');

Object.assign(module.exports, {
  reportedListings: asyncHandler(async (req, res) => { const { items, meta } = await search.listReports(req.query); ok(res, items, meta); }),
  actionAReport: asyncHandler(async (req, res) => ok(res, await search.actionReport(req.params.id, req.body, req))),
});
