// Module F - Lister Verification (KYC) & No-Broker Enforcement: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');
const g = require('../../../core/middleware/guards');

router.get('/kyc', c.ownKyc); // lister: Own KYC
router.put('/kyc', c.saveForm); // lister: Save form
router.post('/kyc/documents', c.uploadDocument); // lister: Upload document
router.delete('/kyc/documents/:docId', c.removeDocument); // lister: Remove document
router.post('/kyc/submit', c.submit); // lister: Submit
router.get('/profile/brand', ...g.builder, c.ownBrand); // lister (builder): Brand and pending change (RE-B-02)
router.patch('/profile/brand', ...g.builder, c.requestBrand); // lister (builder): Request a brand change (admin approval)

module.exports = router;
