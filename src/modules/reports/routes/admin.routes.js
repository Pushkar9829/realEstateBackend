// Module O - Reports, Audit & System Logs: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/reports/:key', ...g.can('reports.view'), c.reportData); // manager, admin (reports.view): Report data
router.get('/reports/:key/export', ...g.can('reports.view'), c.csv); // manager, admin (reports.view): CSV
router.get('/exports/:id', ...g.staffOnly, c.downloadPreparedExport); // admin: Download prepared export
router.get('/audit-logs/export', ...g.can('logs.view'), c.auditExport); // admin (logs.view): Audit CSV (<= 10,000 rows)
router.get('/audit-logs', ...g.can('logs.view'), c.audit); // admin (logs.view): Audit
router.get('/login-history/export', ...g.can('logs.view'), c.loginsExport); // admin (logs.view): Logins CSV (<= 10,000 rows)
router.get('/login-history', ...g.can('logs.view'), c.logins); // admin (logs.view): Logins
router.get('/dashboard', c.dashboard); // manager, admin: Dashboard

module.exports = router;
