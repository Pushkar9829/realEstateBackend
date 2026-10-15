// Module O - Reports, Audit & System Logs: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');

router.get('/properties/:id/stats', c.listingStats); // lister: Listing stats
router.get('/dashboard', c.aggregates); // lister: Aggregates

module.exports = router;
