// Module K - Notifications: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/notification-templates', ...g.can('templates.manage'), c.list); // admin (templates.manage): List
router.patch('/notification-templates/:key/:channel', ...g.can('templates.manage'), c.edit); // admin (templates.manage): Edit
router.post('/notification-templates/:key/:channel/test', ...g.can('templates.manage'), c.testSend); // admin (templates.manage): Test send

module.exports = router;
