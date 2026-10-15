// Module F - Lister Verification (KYC) & No-Broker Enforcement: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');

router.get('/kyc', c.ownKyc); // lister: Own KYC
router.put('/kyc', c.saveForm); // lister: Save form
router.post('/kyc/documents', c.uploadDocument); // lister: Upload document
router.delete('/kyc/documents/:docId', c.removeDocument); // lister: Remove document
router.post('/kyc/submit', c.submit); // lister: Submit

module.exports = router;
