// Module B - Identity & Contact Masking: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');

router.post('/leads/:id/reveal-contact', c.revealBuyerContactAudited); // agent: Reveal buyer contact (audited)
router.post('/properties/:id/reveal-contact', c.revealListerContactAudited); // agent: Reveal lister contact (audited)

module.exports = router;
