// Module B - Identity & Contact Masking: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/contact-reveals', ...g.can('logs.view'), c.revealAudit); // admin (logs.view): Reveal audit

// Admin-panel reveals (same audited service; admins need contacts.view, RE-B-07).
const agentC = require('../controllers/agent.controller');
router.post('/leads/:id/reveal-contact', ...g.can('contacts.view'), agentC.revealBuyerContactAudited); // admin (contacts.view): Reveal buyer contact
router.post('/properties/:id/reveal-contact', ...g.can('contacts.view'), agentC.revealListerContactAudited); // admin (contacts.view): Reveal lister contact

module.exports = router;
