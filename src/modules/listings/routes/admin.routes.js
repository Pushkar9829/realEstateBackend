// Module A - Property Listing & Catalog Management: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/verification/photo-sessions', ...g.can('verification.review'), c.qaQueue); // admin (verification.review): QA queue
router.get('/verification/photo-sessions/:id', ...g.can('verification.review'), c.qaDetail); // admin (verification.review): Session detail with signed photo links
router.post('/verification/photo-sessions/:id/claim', ...g.can('verification.review'), c.claim); // admin (verification.review): Claim
router.post('/verification/photo-sessions/:id/decision', ...g.can('verification.review'), c.approveReject); // admin (verification.review): Approve / reject
router.post('/verification/photo-sessions/:id/release', ...g.can('verification.review'), c.releaseClaim); // admin (verification.review): Release claim
router.get('/sold-elsewhere-checks', ...g.can('receivables.manage'), c.checksList); // admin (receivables.manage): Checks list
router.patch('/sold-elsewhere-checks/:id', ...g.can('receivables.manage'), c.assignDecide); // admin (receivables.manage): Assign, decide

module.exports = router;
