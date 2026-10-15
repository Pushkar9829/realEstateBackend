// Module O - Reports, Audit & System Logs: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/health', c.dbStatusAndVersion); // public: DB status and version

module.exports = router;
