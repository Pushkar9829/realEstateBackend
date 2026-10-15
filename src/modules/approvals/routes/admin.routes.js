// Module D - Admin Approval & Operations: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/verification/visits', ...g.can('verification.schedule', 'verification.field'), c.visitsListOwnVisits); // admin (verification.schedule, verification.field): Visits list / own visits
router.post('/verification/visits', ...g.can('verification.schedule'), c.schedule); // admin (verification.schedule): Schedule
router.patch('/verification/visits/:id', ...g.can('verification.schedule'), c.rescheduleReassign); // admin (verification.schedule): Reschedule, reassign
router.post('/verification/visits/:id/cancel', ...g.can('verification.schedule'), c.cancel); // admin (verification.schedule): Cancel
router.get('/properties', ...g.staffOnly, c.filteredListQueue); // admin: Filtered list / queue
router.post('/properties/export', ...g.staffOnly, c.csv); // admin: CSV
router.get('/properties/:id', ...g.staffOnly, c.fullPrivateView); // admin: Full private view
router.post('/properties/:id/claim', ...g.can('properties.approve'), c.claimReview); // admin (properties.approve): Claim review
router.post('/properties/:id/release', ...g.staffOnly, c.releaseClaim); // admin: Release claim
router.post('/properties/:id/decision', ...g.can('properties.approve'), c.approveChangesReject); // admin (properties.approve): Approve / changes / reject
router.get('/properties/:id/files/:fileId', ...g.can('properties.approve'), c.privateFileUrl); // admin (properties.approve): Signed link to a private listing file (RE-B-12)
router.patch('/properties/:id/media/:mediaId/moderation', ...g.staffOnly, c.mediaDecision); // admin: Media decision
router.patch('/properties/:id', ...g.can('properties.manage'), c.featureExtendDeactivateSuspend); // admin (properties.manage): Feature, extend, deactivate, suspend
router.get('/properties/:id/history', ...g.staffOnly, c.statusAndRevisionHistory); // admin: Status and revision history
router.get('/agreements', c.registry); // manager, admin: Registry
router.get('/agreements/export', ...g.staffOnly, c.csvGet); // admin: CSV
router.get('/agreements/:id', c.detailAndVersions); // manager, admin: Detail and versions
router.get('/agreements/:id/pdf', c.pdf); // manager, admin: PDF
router.post('/agreements/:id/signed-document', ...g.can('agreements.manage'), c.uploadSignedPdf); // admin (agreements.manage): Upload signed PDF
router.post('/agreements/:id/terminate', ...g.can('agreements.manage'), c.terminate); // admin (agreements.manage): Terminate
router.post('/agreements/:id/request-new-version', ...g.can('agreements.manage'), c.askListerToReAccept); // admin (agreements.manage): Ask lister to re-accept

module.exports = router;
