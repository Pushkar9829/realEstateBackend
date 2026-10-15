// Module F - Lister Verification (KYC) & No-Broker Enforcement: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');

router.post('/leads/:id/seeker-flag', c.manualFlagWithNote); // agent: Manual flag with note

module.exports = router;
