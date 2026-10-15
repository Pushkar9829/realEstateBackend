// Module I - Commission Receivables & Invoicing: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/receivables', c.list); // manager, admin: List
router.get('/receivables/export', ...g.staffOnly, c.csv); // admin: CSV
router.get('/receivables/:id', c.detail); // manager, admin: Detail
router.post('/receivables/:id/invoices', ...g.can('invoices.issue'), c.draftInvoice); // admin (invoices.issue): Draft invoice
router.post('/invoices/:id/issue', ...g.can('invoices.issue'), c.issueEmail); // admin (invoices.issue): Issue + email
router.post('/invoices/:id/cancel', ...g.can('invoices.issue'), c.cancelWithCreditNote); // admin (invoices.issue): Cancel with credit note
router.get('/invoices/:id/pdf', ...g.staffOnly, c.pdf); // admin: PDF
router.post('/receivables/remind', ...g.can('receivables.manage'), c.bulkReminders); // admin (receivables.manage): Bulk reminders
router.post('/receivables/:id/payments', ...g.can('receivables.manage'), c.recordPayment); // admin (receivables.manage): Record payment
router.post('/receivables/:id/payment-proofs/:proofId/decision', ...g.can('receivables.manage'), c.confirmRejectProof); // admin (receivables.manage): Confirm / reject proof
router.post('/receivables/:id/dispute', ...g.can('receivables.manage'), c.raiseDispute); // admin (receivables.manage): Raise dispute
router.post('/receivables/:id/dispute/resolve', ...g.can('receivables.manage'), c.resolve); // admin (receivables.manage): Resolve
router.post('/receivables/:id/write-off', ...g.can('receivables.manage'), c.writeOff); // admin (receivables.manage): Write off

module.exports = router;
