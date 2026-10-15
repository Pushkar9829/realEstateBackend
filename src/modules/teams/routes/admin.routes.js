// Module J - Teams & Territory Management: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/teams', c.list); // manager, admin: List
router.post('/teams', ...g.can('teams.manage'), c.create); // admin (teams.manage): Create
router.patch('/teams/:id', ...g.can('teams.manage'), c.edit); // admin (teams.manage): Edit
router.delete('/teams/:id', ...g.can('teams.manage'), c.deleteNoOpenLeads); // admin (teams.manage): Delete (no open leads)
router.patch('/teams/:id/members/:agentId', c.capacityAvailability); // manager, admin: Capacity, availability
router.get('/routing-rules', ...g.can('routing.manage'), c.listGet); // admin (routing.manage): List
router.post('/routing-rules', ...g.can('routing.manage'), c.createPost); // admin (routing.manage): Create
router.patch('/routing-rules/reorder', ...g.can('routing.manage'), c.reorder); // admin (routing.manage): Reorder
router.post('/routing-rules/simulate', ...g.can('routing.manage'), c.simulate); // admin (routing.manage): Simulate
router.patch('/routing-rules/:id', ...g.can('routing.manage'), c.editPatch); // admin (routing.manage): Edit
router.delete('/routing-rules/:id', ...g.can('routing.manage'), c.delete); // admin (routing.manage): Delete
router.get('/staff', ...g.can('staff.manage'), c.list2); // admin (staff.manage): List
router.post('/staff', ...g.can('staff.manage'), c.create2); // admin (staff.manage): Create
router.patch('/staff/:id', ...g.can('staff.manage'), c.edit2); // admin (staff.manage): Edit
router.post('/staff/:id/disable', ...g.can('staff.manage'), c.disableWithReassignment); // admin (staff.manage): Disable with reassignment
router.post('/staff/:id/reset-2fa', ...g.can('staff.manage'), c.reset2fa); // admin (staff.manage): Reset 2FA
router.post('/staff/:id/force-logout', ...g.can('staff.manage'), c.revokeSessions); // admin (staff.manage): Revoke sessions

module.exports = router;
