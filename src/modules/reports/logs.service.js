// Module O - audit trail and login history (logs.view): shared filters for the
// list endpoints and the CSV exports (RE-O-05 / RE-O-06). Exports are live and
// capped at 10,000 rows (newest first); the X-Export-Truncated header says when
// the cap was hit so the admin can narrow the filters.
const { AuditLog, audit } = require('../../core/audit');
const { LoginHistory } = require('../auth/models');
const { ApiError } = require('../../core/http');

const EXPORT_MAX_ROWS = 10000;
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oid = /^[a-f0-9]{24}$/;

function dateRange(q) {
  if (!q.from && !q.to) return undefined;
  const from = q.from ? new Date(q.from) : null;
  const to = q.to ? new Date(q.to) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) throw ApiError.validation([{ in: 'query', path: from && Number.isNaN(from.getTime()) ? 'from' : 'to', message: 'Not a valid date' }]);
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
}

// GET /api/admin/audit-logs?action=&entityType=&entityId=&actorId=&from=&to=
function auditFilter(q) {
  const filter = {};
  if (q.action) filter.action = new RegExp(`^${escapeRx(q.action)}`);
  ['entityType', 'entityId', 'actorId'].forEach((k) => { if (q[k]) filter[k] = q[k]; });
  const at = dateRange(q);
  if (at) filter.at = at;
  return filter;
}

// GET /api/admin/login-history?userId=&success=&from=&to=
function loginFilter(q) {
  const filter = {};
  if (q.userId) filter.userId = q.userId;
  if (q.success) filter.success = q.success === 'true';
  const at = dateRange(q);
  if (at) filter.at = at;
  return filter;
}

const cell = (v) => {
  const s = v === undefined || v === null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralise spreadsheet formulas and quote when needed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (head, rows) => [head.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');

function send(res, name, csv, truncated) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('X-Export-Truncated', truncated ? 'true' : 'false');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Content-Disposition, X-Export-Truncated');
  return res.send(csv);
}

async function exportAudit(query, res, req) {
  if (query.actorId && !oid.test(String(query.actorId))) throw ApiError.validation([{ in: 'query', path: 'actorId', message: 'Not a valid id' }]);
  const filter = auditFilter(query);
  const rows = await AuditLog.find(filter).sort({ at: -1 }).limit(EXPORT_MAX_ROWS + 1).populate('actorId', 'name email role').lean();
  const truncated = rows.length > EXPORT_MAX_ROWS;
  const list = rows.slice(0, EXPORT_MAX_ROWS);
  const head = ['at', 'actor', 'actorEmail', 'actorRole', 'action', 'entityType', 'entityId', 'reason', 'ip'];
  const csv = toCsv(head, list.map((x) => {
    const a = x.actorId && typeof x.actorId === 'object' ? x.actorId : null;
    return [x.at, a ? a.name : (x.actorRole === 'system' ? 'System' : ''), a ? a.email : '', x.actorRole, x.action, x.entityType, x.entityId, x.reason, x.ip];
  }));
  await audit(req, { action: 'audit_logs.export', entityType: 'AuditLog', after: { rows: list.length, truncated, filters: { ...query } } });
  return send(res, 'audit-logs', csv, truncated);
}

async function exportLogins(query, res, req) {
  if (query.userId && !oid.test(String(query.userId))) throw ApiError.validation([{ in: 'query', path: 'userId', message: 'Not a valid id' }]);
  const rows = await LoginHistory.find(loginFilter(query)).sort({ at: -1 }).limit(EXPORT_MAX_ROWS + 1).populate('userId', 'name email role').lean();
  const truncated = rows.length > EXPORT_MAX_ROWS;
  const list = rows.slice(0, EXPORT_MAX_ROWS);
  const head = ['at', 'user', 'email', 'role', 'success', 'method', 'reason', 'ip', 'userAgent'];
  const csv = toCsv(head, list.map((x) => {
    const u = x.userId && typeof x.userId === 'object' ? x.userId : null;
    return [x.at, u ? u.name : '', u ? u.email : '', u ? u.role : '', x.success ? 'yes' : 'no', x.method, x.reason, x.ip, x.ua];
  }));
  await audit(req, { action: 'login_history.export', entityType: 'LoginHistory', after: { rows: list.length, truncated, filters: { ...query } } });
  return send(res, 'login-history', csv, truncated);
}

module.exports = { auditFilter, loginFilter, exportAudit, exportLogins, EXPORT_MAX_ROWS };
