// Module E - Search & Discovery: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/listing-reports', ...g.can('properties.manage'), c.reportedListings); // admin (properties.manage): Reported listings
router.patch('/listing-reports/:id', ...g.can('properties.manage'), c.actionAReport); // admin (properties.manage): Action a report

module.exports = router;
