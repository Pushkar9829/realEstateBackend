// Module H - Deals & Receipt Verification: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');

router.post('/leads/:id/referrals', c.homeLoanReferralCould); // agent: Home-loan referral (Could)
router.post('/deals/:id/service-requests', c.rentalAgreementRequestCould); // agent: Rental agreement request (Could)
router.get('/partners', c.activePartners); // agent: Active partners for referrals (type, city)
router.get('/deals', c.ownDeals); // agent: Own deals
router.post('/deals/preview-commission', c.previewCommission); // agent: Commission preview (same computation as the deal; nothing saved)
router.post('/deals', c.createDraft); // agent: Create draft
router.get('/deals/:id', c.detail); // agent: Detail
router.patch('/deals/:id', c.editDraftReturned); // agent: Edit draft / returned
router.post('/deals/:id/documents', c.uploadDocument); // agent: Upload document
router.delete('/deals/:id/documents/:docId', c.removeDocument); // agent: Remove document
router.post('/deals/:id/submit', c.submit); // agent: Submit
router.post('/deals/:id/cancel', c.cancel); // agent: Cancel

module.exports = router;
