// Module F - Lister Verification (KYC) & No-Broker Enforcement: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/kyc', ...g.can('listers.verify'), c.queue); // admin (listers.verify): Queue
router.get('/kyc/:userId', ...g.can('listers.verify'), c.detail); // admin (listers.verify): Detail
router.get('/kyc/:userId/documents/:docId', ...g.can('listers.verify'), c.signedFileUrl); // admin (listers.verify): Signed file URL
router.post('/kyc/:userId/claim', ...g.can('listers.verify'), c.claim); // admin (listers.verify): Claim
router.post('/kyc/:userId/release', ...g.can('listers.verify'), c.release); // admin (listers.verify): Release
router.post('/kyc/:userId/decision', ...g.can('listers.verify'), c.decide); // admin (listers.verify): Decide
router.get('/listers', ...g.staffOnly, c.list); // admin: List
router.get('/listers/:id', ...g.staffOnly, c.detailGet); // admin: Detail
router.patch('/listers/:id/status', ...g.can('listers.manage'), c.suspendBanReinstate); // admin (listers.manage): Suspend / ban / reinstate
router.patch('/listers/:id/limits', ...g.can('listers.manage'), c.listingLimitOverride); // admin (listers.manage): Listing limit override
router.get('/broker-flags', ...g.can('listers.manage'), c.flags); // admin (listers.manage): Flags
router.get('/broker-flags/:id', ...g.can('listers.manage'), c.flagDetail); // admin (listers.manage): Flag detail
router.post('/broker-flags', ...g.can('listers.manage'), c.manualFlag); // admin (listers.manage): Manual flag
router.patch('/broker-flags/:id', ...g.can('listers.manage'), c.resolve); // admin (listers.manage): Resolve
router.get('/seeker-flags', ...g.can('users.manage'), c.seekerFlags); // admin (users.manage): Seeker flags
router.get('/seeker-flags/:id', ...g.can('users.manage'), c.flagWithLeads); // admin (users.manage): Flag with leads
router.patch('/seeker-flags/:id', ...g.can('users.manage'), c.dismissThrottleBlock); // admin (users.manage): Dismiss / throttle / block

module.exports = router;
