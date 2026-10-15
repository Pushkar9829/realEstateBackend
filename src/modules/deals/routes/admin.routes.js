// Module H - Deals & Receipt Verification: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/partners', ...g.can('partners.manage'), c.partners); // admin (partners.manage): Partners
router.post('/partners', ...g.can('partners.manage'), c.createPartner); // admin (partners.manage): Create partner
router.patch('/partners/:id', ...g.can('partners.manage'), c.editDeactivate); // admin (partners.manage): Edit / deactivate
router.get('/partners/:id/agreement', ...g.can('partners.manage'), c.partnerAgreement); // admin (partners.manage): Signed link to the partner agreement
router.get('/partner-referrals', ...g.can('partners.manage'), c.referralsAndRequests); // admin (partners.manage): Referrals and requests
router.patch('/partner-referrals/:id', ...g.can('partners.manage'), c.statusPayout); // admin (partners.manage): Status, payout
router.get('/deals', c.queue); // manager, admin: Queue
router.get('/deals/:id', c.detail); // manager, admin: Detail
router.get('/deals/:id/documents/:docId', ...g.can('deals.verify'), c.signedFileUrl); // admin (deals.verify): Signed file URL
router.post('/deals/:id/claim', ...g.can('deals.verify'), c.claim); // admin (deals.verify): Claim
router.post('/deals/:id/release', ...g.can('deals.verify'), c.release); // admin (deals.verify): Release
router.post('/deals/:id/decision', ...g.can('deals.verify'), c.verifyReturnReject); // admin (deals.verify): Verify / return / reject
router.post('/deals/:id/reverse', ...g.can('deals.verify'), c.reverse); // admin (deals.verify): Reverse

module.exports = router;
