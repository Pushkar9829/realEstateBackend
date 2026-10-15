// Module C - Integrated Lead Management System: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/leads', c.allLeads); // manager, admin: All leads
router.post('/leads/bulk-assign', c.bulkAssign); // manager, admin: Bulk assign
router.get('/leads/queue', c.queuePanels); // manager, admin: Queue panels
router.get('/leads/export', ...g.can('leads.export'), c.csv); // admin (leads.export): CSV
router.get('/leads/:id', c.detail); // manager, admin: Detail
router.post('/leads/:id/assign', c.assignReassign); // manager, admin: Assign / reassign
router.post('/leads/:id/reopen', c.reopenLost); // manager, admin: Reopen lost
router.post('/leads/:id/recycle', c.newLeadFromOldLostLead); // manager, admin: New lead from old lost lead
router.post('/leads/:id/notes', c.addNote); // manager, admin: Note on the lead timeline
router.post('/leads/:id/merge', c.mergeDuplicates); // manager, admin: Merge duplicates
router.post('/leads/:id/reassign-requests/:reqId/decision', c.decideRequest); // manager, admin: Decide request
router.get('/site-visits', c.allVisits); // manager, admin: All visits
router.patch('/site-visits/:id', c.reassignAgent); // manager, admin: Reassign agent

module.exports = router;
