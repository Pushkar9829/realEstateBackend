// /api/cc/* adapter endpoints (CC_CONTRACT.md section 5). Every route is
// HMAC-verified (hmac.authenticate) and scope-checked. Writes need the acting
// Control Center user (X-CC-Actor); they run as that user's linked staff
// account so the platform's own rules and audit apply (D8).
const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const mongoSanitize = require('express-mongo-sanitize');
const hmac = require('./hmac');
const state = require('./state');
const sso = require('./sso');
const config = require('./config');
const { CcLink } = require('./models');
const provider = require('./provider');

const { ApiError } = provider;
const started = Date.now();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => {
  if (!res.headersSent) res.status(res.statusCode === 200 ? 200 : res.statusCode).json({ success: true, data });
}).catch(next);
const parse = (schema, value) => {
  const r = schema.safeParse(value || {});
  if (!r.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Validation failed', r.error.issues.map((i) => ({ in: 'body', path: i.path.join('.'), message: i.message })));
  return r.data;
};

// Runs the request as the acting Control Center user's linked staff account.
async function asActor(req) {
  const a = req.ccActor;
  if (!a) throw new ApiError(400, 'missing_actor', 'X-CC-Actor is required for changes');
  const role = provider.sso.actorRoles[a.role];
  if (!role) throw new ApiError(403, 'actor_denied', 'This Control Center role cannot change anything here');
  req.user = await sso.linkedUser(a, role);
  if (req.user.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'The linked Control Center account is disabled on this platform');
  return req.user;
}
const ccAudit = (req, action, extra = {}) => provider.audit(req, { action, reason: extra.reason ? `${extra.reason} (via Control Center)` : 'via Control Center', ...extra });

const RANGES = { today: 0, '7d': 7, '30d': 30 };
function rangeOf(r) {
  const key = Object.prototype.hasOwnProperty.call(RANGES, r) ? r : 'today';
  const to = new Date();
  const from = new Date(to);
  // "today" starts at midnight India time (UTC+5:30), the platforms' business day.
  const ist = new Date(to.getTime() + 330 * 60000);
  ist.setUTCHours(0, 0, 0, 0);
  from.setTime(ist.getTime() - 330 * 60000 - RANGES[key] * 86400000);
  return { range: key, from, to };
}

async function dbPing() {
  const t = Date.now();
  try { await mongoose.connection.db.admin().ping(); return { state: 'up', pingMs: Date.now() - t }; } catch { return { state: 'down', pingMs: null }; }
}

const router = express.Router();
router.use(express.raw({ type: () => true, limit: '256kb' }), (req, res, next) => {
  req.rawBody = Buffer.isBuffer(req.body) && req.body.length ? req.body.toString('utf8') : '';
  next();
}, hmac.authenticate, (req, res, next) => { mongoSanitize.sanitize(req.body); next(); });

router.get('/health', hmac.scope('ops.read'), wrap(async () => {
  const [db, extra, s] = await Promise.all([dbPing(), provider.health(), state.get()]);
  return {
    platform: provider.code, status: s.maintenance && s.maintenance.on ? 'maintenance' : db.state === 'up' ? 'ok' : 'degraded',
    version: provider.version, env: provider.env, uptimeSec: Math.round((Date.now() - started) / 1000), time: new Date().toISOString(),
    db, ...extra,
    maintenance: { on: Boolean(s.maintenance && s.maintenance.on), message: (s.maintenance && s.maintenance.message) || null, since: (s.maintenance && s.maintenance.since) || null },
    flags: Object.fromEntries(provider.flags.map((f) => [f.key, Boolean(s.flags[f.key] && s.flags[f.key].paused)])),
  };
}));

router.get('/summary', hmac.scope('ops.read'), wrap(async (req) => {
  const r = rangeOf(req.query.range);
  const out = await provider.summary(r);
  return { platform: provider.code, range: r.range, from: r.from, to: r.to, currency: 'INR', ...out };
}));

router.get('/approvals', hmac.scope('ops.read'), wrap(async () => {
  const queues = await provider.approvals();
  return { platform: provider.code, total: queues.reduce((s, q) => s + q.count, 0), queues };
}));

router.get('/security', hmac.scope('ops.read'), wrap(async () => {
  const since = new Date(Date.now() - 24 * 3600000);
  const { SecurityEvent, AuditLog } = provider.models;
  const [counts, recent, extra] = await Promise.all([
    SecurityEvent.aggregate([{ $match: { at: { $gte: since } } }, { $group: { _id: '$type', n: { $sum: 1 } } }]),
    AuditLog.find({ actorRole: { $in: provider.staffRoles } }).sort({ at: -1 }).limit(20).select('action actorId actorRole entityType at').lean(),
    provider.securityExtras(),
  ]);
  return {
    platform: provider.code, window: '24h', counts: Object.fromEntries(counts.map((c) => [c._id, c.n])), ...extra,
    recentAdminActions: recent.map((a) => ({ action: a.action, actorId: a.actorId, actorRole: a.actorRole, entityType: a.entityType, at: a.at })),
  };
}));

router.get('/integrations', hmac.scope('ops.read'), wrap(async () => ({ platform: provider.code, ...(await provider.integrations()) })));
if (provider.replay) {
  router.post('/integrations/replay', hmac.scope('ops.write'), wrap(async (req) => {
    await asActor(req);
    const body = parse(z.object({ platform: z.string().min(2).max(20), eventIds: z.array(z.string().min(1).max(64)).min(1).max(50) }), req.body);
    const out = await provider.replay(body, req);
    await ccAudit(req, 'cc.integrations.replay', { after: { platform: body.platform, count: body.eventIds.length } });
    return out;
  }));
}

// ---- Staff ----
router.get('/staff', hmac.scope('staff.read'), wrap(async (req) => {
  const items = await provider.staff.list(req.query);
  const links = await CcLink.find({ userId: { $in: items.map((i) => i.id) } }).select('userId').lean();
  const linked = new Set(links.map((l) => String(l.userId)));
  return { roles: provider.staff.roles, items: items.map((i) => ({ ...i, viaControlCenter: linked.has(String(i.id)) })) };
}));

router.post('/staff', hmac.scope('staff.write'), wrap(async (req, res) => {
  await asActor(req);
  const body = parse(z.object({
    name: z.string().trim().min(2).max(80), email: z.string().email(), phone: z.string().trim().max(20).optional(),
    role: z.enum(provider.staff.roles), permissions: z.array(z.string().max(60)).max(60).optional(),
  }), req.body);
  const out = await provider.staff.invite(body, req);
  await ccAudit(req, 'cc.staff.invite', { entityType: 'User', entityId: out.id, after: { role: body.role, email: body.email } });
  res.status(201);
  return out;
}));

const staffPatch = z.union([
  z.object({ role: z.string().min(2).max(40) }).strict(),
  z.object({ status: z.literal('disabled'), reason: z.string().max(300).optional(), revokeSessions: z.boolean().optional() }).strict(),
  z.object({ status: z.literal('active') }).strict(),
  z.object({ action: z.enum(['force_logout', 'reset_2fa']) }).strict(),
]);

router.patch('/staff/:id', hmac.scope('staff.write'), wrap(async (req) => {
  await asActor(req);
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found');
  const body = parse(staffPatch, req.body);
  let action; let result;
  if (body.role) { action = 'role'; result = await provider.staff.setRole(req.params.id, body.role, req); }
  else if (body.status === 'disabled') { action = 'disable'; result = await provider.staff.disable(req.params.id, { reason: body.reason || 'Disabled from the Control Center' }, req); }
  else if (body.status === 'active') { action = 'enable'; result = await provider.staff.enable(req.params.id, req); }
  else if (body.action === 'force_logout') { action = 'force_logout'; result = await provider.staff.forceLogout(req.params.id, req); }
  else { action = 'reset_2fa'; result = await provider.staff.reset2fa(req.params.id, req); }
  await ccAudit(req, `cc.staff.${action}`, { entityType: 'User', entityId: req.params.id, after: body.role ? { role: body.role } : undefined, reason: body.reason });
  return { id: req.params.id, result };
}));

// ---- Settings ----
router.get('/settings', hmac.scope('settings.read'), wrap(async () => ({ items: await provider.settings.list() })));

router.get('/settings/history', hmac.scope('settings.read'), wrap(async (req) => {
  const key = typeof req.query.key === 'string' ? req.query.key : null;
  const filter = { action: { $in: provider.settings.auditActions } };
  const rows = await provider.models.AuditLog.find(filter).sort({ at: -1 }).limit(key ? 500 : 50).lean();
  const items = [];
  rows.forEach((r) => {
    const keys = Object.keys({ ...(r.after || {}), ...(r.before || {}) }).filter((k) => !['key', 'value'].includes(k));
    const pairs = r.after && r.after.key ? [[r.after.key, r.before && r.before.value, r.after.value]] : keys.map((k) => [k, r.before && r.before[k], r.after && r.after[k]]);
    pairs.forEach(([k, before, after]) => { if (!key || k === key) items.push({ key: k, before, after, at: r.at, actorRole: r.actorRole, actorId: r.actorId }); });
  });
  return { items: items.slice(0, 50) };
}));

router.patch('/settings', hmac.scope('settings.write'), wrap(async (req) => {
  await asActor(req);
  const body = parse(z.object({ key: z.string().min(1).max(100), value: z.any(), reason: z.string().max(300).optional() }), req.body);
  if (body.value === undefined) throw new ApiError(422, 'VALIDATION_ERROR', 'Validation failed', [{ in: 'body', path: 'value', message: 'Required' }]);
  const out = await provider.settings.update(body, req);
  await ccAudit(req, 'cc.settings.update', { entityType: 'Setting', before: { key: body.key, value: out.before }, after: { key: body.key, value: out.after }, reason: body.reason });
  return out;
}));

// ---- Maintenance and kill switches ----
router.post('/maintenance', hmac.scope('ops.write'), wrap(async (req) => {
  const actor = await asActor(req);
  const body = parse(z.object({ on: z.boolean(), message: z.string().trim().max(300).optional() }), req.body);
  const before = (await state.get()).maintenance;
  const s = await state.update({ maintenance: { on: body.on, message: body.on ? body.message || null : null, since: body.on ? new Date() : null, by: String(actor._id) } });
  await ccAudit(req, body.on ? 'cc.maintenance.on' : 'cc.maintenance.off', { entityType: 'Platform', before: { on: Boolean(before && before.on) }, after: { on: body.on, message: body.message } });
  return { maintenance: { on: s.maintenance.on, message: s.maintenance.message, since: s.maintenance.since } };
}));

router.get('/flags', hmac.scope('ops.read'), wrap(async () => {
  const s = await state.get();
  return { items: provider.flags.map((f) => ({ key: f.key, label: f.label, description: f.description, paused: Boolean(s.flags[f.key] && s.flags[f.key].paused), since: s.flags[f.key] && s.flags[f.key].since, reason: s.flags[f.key] && s.flags[f.key].reason })) };
}));

router.post('/flags', hmac.scope('ops.write'), wrap(async (req) => {
  const actor = await asActor(req);
  const body = parse(z.object({ key: z.enum(provider.flags.map((f) => f.key)), paused: z.boolean(), reason: z.string().trim().max(300).optional() }), req.body);
  await state.update({ [`flags.${body.key}`]: { paused: body.paused, reason: body.reason || null, since: new Date(), by: String(actor._id) } });
  await ccAudit(req, body.paused ? 'cc.flags.pause' : 'cc.flags.resume', { entityType: 'Platform', after: { key: body.key, paused: body.paused }, reason: body.reason });
  return { key: body.key, paused: body.paused };
}));

// ---- Key rotation (B10) ----
router.post('/keys/rotate', hmac.scope('keys.write'), wrap(async (req) => {
  await asActor(req);
  const body = parse(z.object({ keyId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), secret: z.string().min(32).max(200) }), req.body);
  const current = (await hmac.candidates())[0];
  await state.update({
    key: {
      keyId: body.keyId, secretEnc: provider.encrypt(body.secret), previousKeyId: current.keyId, previousSecretEnc: provider.encrypt(current.secret),
      previousUntil: new Date(Date.now() + 24 * 3600000), rotatedAt: new Date(),
    },
  });
  await ccAudit(req, 'cc.keys.rotate', { entityType: 'Platform', after: { keyId: `${body.keyId.slice(0, 10)}...` } });
  return { rotated: true, keyId: body.keyId };
}));

module.exports = { router, rangeOf, asActor, scopes: () => config.read().scopes };
