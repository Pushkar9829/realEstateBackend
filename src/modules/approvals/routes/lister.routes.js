// Module D - Admin Approval & Operations: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');

router.post('/properties/:id/verification/site-request', c.askForASiteVisitCould); // lister: Ask for a site visit (Could)
router.get('/agreements', c.ownAgreements); // lister: Own agreements
router.get('/agreements/:id', c.detail); // lister: Detail
router.get('/agreements/:id/pdf', c.pdf); // lister: PDF

module.exports = router;
