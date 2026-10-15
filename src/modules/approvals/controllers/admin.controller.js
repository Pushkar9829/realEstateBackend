// Module D - Admin Approval & Operations: admin panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('D', [
  'visitsListOwnVisits', // GET /api/admin/verification/visits - Visits list / own visits
  'schedule', // POST /api/admin/verification/visits - Schedule
  'rescheduleReassign', // PATCH /api/admin/verification/visits/:id - Reschedule, reassign
  'cancel', // POST /api/admin/verification/visits/:id/cancel - Cancel
  'filteredListQueue', // GET /api/admin/properties - Filtered list / queue
  'csv', // POST /api/admin/properties/export - CSV
  'fullPrivateView', // GET /api/admin/properties/:id - Full private view
  'claimReview', // POST /api/admin/properties/:id/claim - Claim review
  'releaseClaim', // POST /api/admin/properties/:id/release - Release claim
  'approveChangesReject', // POST /api/admin/properties/:id/decision - Approve / changes / reject
  'mediaDecision', // PATCH /api/admin/properties/:id/media/:mediaId/moderation - Media decision
  'featureExtendDeactivateSuspend', // PATCH /api/admin/properties/:id - Feature, extend, deactivate, suspend
  'statusAndRevisionHistory', // GET /api/admin/properties/:id/history - Status and revision history
  'registry', // GET /api/admin/agreements - Registry
  'csvGet', // GET /api/admin/agreements/export - CSV
  'detailAndVersions', // GET /api/admin/agreements/:id - Detail and versions
  'pdf', // GET /api/admin/agreements/:id/pdf - PDF
  'uploadSignedPdf', // POST /api/admin/agreements/:id/signed-document - Upload signed PDF
  'terminate', // POST /api/admin/agreements/:id/terminate - Terminate
  'askListerToReAccept', // POST /api/admin/agreements/:id/request-new-version - Ask lister to re-accept
]);

// ---- Phase 2: listing review, admin listing actions, agreement registry ----
// (Site verification visits - RE-D-13, Could - stay designed.)
const { asyncHandler, ok } = require('../../../core/http');
const review = require('../review.service');
const agreements = require('../agreements.service');

const list = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req.query); ok(res, items, meta); });
const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));

Object.assign(module.exports, {
  filteredListQueue: list(review.listQueue), // ?queue=revisions | ?status=
  csv: asyncHandler(async (req, res) => review.exportCsv({ ...req.query, ...req.body }, res)),
  fullPrivateView: run((req) => review.fullView(req.params.id)),
  claimReview: run((req) => review.claim(req.params.id, req)),
  releaseClaim: run((req) => review.release(req.params.id, req)),
  approveChangesReject: run((req) => review.decide(req.params.id, req.body, req)),
  mediaDecision: run((req) => review.moderateMedia(req.params.id, req.params.mediaId, req.body, req)),
  privateFileUrl: run((req) => review.fileUrl(req.params.id, req.params.fileId, req)), // GET /api/admin/properties/:id/files/:fileId - Signed link (RE-B-12)
  featureExtendDeactivateSuspend: run((req) => review.adminAction(req.params.id, req.body, req)),
  statusAndRevisionHistory: run((req) => review.history(req.params.id)),
  registry: list((q) => agreements.list(q)),
  csvGet: asyncHandler(async (req, res) => agreements.exportCsv(res)),
  detailAndVersions: run((req) => agreements.get(req.params.id)),
  pdf: asyncHandler(async (req, res) => agreements.pdf(req.params.id, res)),
  uploadSignedPdf: run((req) => agreements.uploadSigned(req.params.id, req.body, req)),
  terminate: run((req) => agreements.terminate(req.params.id, req.body, req)),
  askListerToReAccept: run((req) => agreements.requestNewVersion(req.params.id, req.body, req)),
});


// ---- Phase 6: site verification visits (RE-D-13, Could) ----
const siteVisits = require('../site-visits.service');

Object.assign(module.exports, {
  visitsListOwnVisits: asyncHandler(async (req, res) => { const { items, meta } = await siteVisits.list(req.user, req.query); ok(res, items, meta); }),
  schedule: asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await siteVisits.schedule(req.user, req.body, req) })),
  rescheduleReassign: asyncHandler(async (req, res) => ok(res, await siteVisits.patch(req.user, req.params.id, req.body, req))),
  cancel: asyncHandler(async (req, res) => ok(res, await siteVisits.cancel(req.user, req.params.id, req.body, req))),
});
