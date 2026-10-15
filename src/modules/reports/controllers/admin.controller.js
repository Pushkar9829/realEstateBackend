// Module O - admin panel: reports (team-scoped for managers), exports, dashboard,
// audit trail and login history (logs.view).
const { asyncHandler, ok, paginate } = require('../../../core/http');
const { AuditLog } = require('../../../core/audit');
const { LoginHistory } = require('../../auth/models');
const svc = require('../service');
const logs = require('../logs.service');

module.exports = {
  reportData: asyncHandler(async (req, res) => ok(res, await svc.run(req.user, req.params.key, req.query))),
  csv: asyncHandler(async (req, res) => svc.exportCsv(req.user, req.params.key, req.query, res, req)),
  downloadPreparedExport: asyncHandler(async (req, res) => ok(res, await svc.download(req.user, req.params.id, req))),
  dashboard: asyncHandler(async (req, res) => ok(res, await svc.adminDashboard(req.user))),
  // GET /api/admin/audit-logs?action=&entityType=&entityId=&actorId=&from=&to=
  audit: asyncHandler(async (req, res) => {
    const { items, meta } = await paginate(AuditLog, logs.auditFilter(req.query), { ...req.query, sort: '-at' }, { populate: { path: 'actorId', select: 'name email role' } });
    ok(res, items, meta);
  }),
  // GET /api/admin/audit-logs/export (same filters; CSV, at most 10,000 rows)
  auditExport: asyncHandler(async (req, res) => logs.exportAudit(req.query, res, req)),
  // GET /api/admin/login-history?userId=&success=&from=&to=
  logins: asyncHandler(async (req, res) => {
    const { items, meta } = await paginate(LoginHistory, logs.loginFilter(req.query), { ...req.query, sort: '-at' }, { populate: { path: 'userId', select: 'name email role' } });
    ok(res, items, meta);
  }),
  // GET /api/admin/login-history/export (same filters; CSV, at most 10,000 rows)
  loginsExport: asyncHandler(async (req, res) => logs.exportLogins(req.query, res, req)),
};
