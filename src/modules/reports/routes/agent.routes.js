// Module O - Reports, Audit & System Logs: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');

router.get('/performance', c.ownKpis); // agent: Own KPIs

module.exports = router;
