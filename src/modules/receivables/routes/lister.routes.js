// Module I - Commission Receivables & Invoicing: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');

router.get('/invoices', c.ownInvoices); // lister: Own invoices
router.get('/invoices/:id', c.detail); // lister: Detail
router.get('/invoices/:id/pdf', c.pdf); // lister: PDF
router.post('/invoices/:id/payment-proof', c.uploadProof); // lister: Upload proof
router.post('/invoices/:id/dispute', c.raiseDispute); // lister: Raise dispute

module.exports = router;
