// Module G - Builder Projects: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/projects', ...g.staffOnly, c.queueList); // admin: Queue / list
router.get('/projects/:id', ...g.staffOnly, c.detail); // admin: Detail
router.get('/projects/:id/files/:fileId', ...g.can('projects.approve'), c.privateFileUrl); // admin (projects.approve): Signed link to a RERA file (RE-B-12)
router.post('/projects/:id/claim', ...g.can('projects.approve'), c.claim); // admin (projects.approve): Claim
router.post('/projects/:id/decision', ...g.can('projects.approve'), c.decide); // admin (projects.approve): Decide
router.patch('/projects/:id', ...g.staffOnly, c.featureDeactivate); // admin: Feature / deactivate

module.exports = router;
