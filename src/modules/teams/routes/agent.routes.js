// Module J - Teams & Territory Management: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');

router.get('/availability', c.myAvailability); // agent: Own availability and leave (RE-S-AGT-16)
router.patch('/availability', c.availabilityLeave); // agent: Availability / leave

module.exports = router;
