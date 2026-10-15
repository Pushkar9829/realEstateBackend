// RE-M-07 / RE-M-08 staff provisioning (agents, managers, admin staff).
// Admin creates the account with a temporary password (emailed); the staff
// member must change it on first login. Effective permissions:
//   manager -> MANAGER_DEFAULTS (+ extra keys), admin -> chosen keys,
//   agent   -> only `verification.field` may be granted.
const crypto = require('crypto');
const { User } = require('../models');
const auth = require('./auth.service');
const sessions = require('./session.service');
const { notifyUser } = require('../../notifications/service');
const { ApiError, paginate } = require('../../../core/http');
const { audit } = require('../../../core/audit');
const { ALL_PERMISSIONS, MANAGER_DEFAULTS } = require('../../../constants/permissions');
const env = require('../../../config/env');

const STAFF = ['agent', 'manager', 'admin', 'superadmin'];
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function effectivePermissions(role, extra = []) {
  const unknown = extra.filter((k) => !ALL_PERMISSIONS.includes(k));
  if (unknown.length) throw ApiError.validation([{ in: 'body', path: 'permissions', message: `Unknown permission keys: ${unknown.join(', ')}` }]);
  if (role === 'agent') {
    const bad = extra.filter((k) => k !== 'verification.field');
    if (bad.length) throw ApiError.validation([{ in: 'body', path: 'permissions', message: 'Agents can only be given verification.field' }]);
    return [...new Set(extra)];
  }
  if (role === 'manager') return [...new Set([...MANAGER_DEFAULTS, ...extra])].sort();
  return [...new Set(extra)].sort();
}

const tempPassword = () => `${crypto.randomBytes(6).toString('base64url')}a9`;

function list(query) {
  const filter = { role: query.role && STAFF.includes(query.role) ? query.role : { $in: STAFF } };
  if (query.status) filter.status = query.status;
  if (query.teamId) filter.teamId = query.teamId;
  if (query.q) filter.$or = ['name', 'email', 'phone'].map((f) => ({ [f]: new RegExp(escapeRx(String(query.q)), 'i') }));
  return paginate(User, filter, query, { projection: '+permissions' });
}

async function create(data, req) {
  if (!data.phone.startsWith('+91')) throw ApiError.validation([{ in: 'body', path: 'phone', message: 'Staff accounts need an Indian mobile number' }]);
  if (await User.exists({ $or: [{ email: data.email }, { phone: data.phone }] })) throw ApiError.conflict('Email or phone already registered', 'ALREADY_REGISTERED');
  if (data.role === 'admin' && req.user.role !== 'superadmin') throw ApiError.forbidden('Only a super admin can create admin staff');
  const password = tempPassword();
  const user = await User.create({
    name: data.name, email: data.email, phone: data.phone, role: data.role, teamId: data.teamId,
    extraPermissions: data.permissions, permissions: effectivePermissions(data.role, data.permissions),
    passwordHash: await auth.hashPassword(password), mustChangePassword: true, status: 'active',
    emailVerified: true, phoneVerified: true, invitedBy: req.user._id, referralCode: await auth.uniqueReferralCode(),
  });
  await notifyUser({ user, event: 'staff.created', channels: ['email'], vars: { role: data.role, tempPassword: password, link: `${env.CLIENT_URL.replace(/\/$/, '')}/login` } });
  await audit(req, { action: 'staff.create', entityType: 'User', entityId: user._id, after: { role: user.role, email: user.email, permissions: user.permissions, teamId: user.teamId } });
  return user.toJSON();
}

async function staffOr404(id, req, { allowSelf = false } = {}) {
  const user = await User.findOne({ _id: id, role: { $in: STAFF } }).select('+permissions');
  if (!user) throw ApiError.notFound('Staff member not found');
  if (user.role === 'superadmin' && req.user.role !== 'superadmin') throw ApiError.forbidden('Only a super admin can change a super admin');
  if (!allowSelf && String(user._id) === String(req.user._id)) throw ApiError.forbidden('You cannot change your own staff account here', 'SELF_CHANGE');
  return user;
}

async function edit(id, data, req) {
  const user = await staffOr404(id, req);
  const before = { teamId: user.teamId, permissions: user.permissions };
  if (data.name) user.name = data.name;
  if (data.teamId !== undefined) user.teamId = data.teamId || undefined;
  if (data.permissions) {
    if (user.role === 'admin' && req.user.role !== 'superadmin') throw ApiError.forbidden('Only a super admin can change admin permissions');
    user.extraPermissions = data.permissions;
    user.permissions = effectivePermissions(user.role, data.permissions);
  }
  await user.save();
  await audit(req, { action: 'staff.edit', entityType: 'User', entityId: user._id, before, after: { teamId: user.teamId, permissions: user.permissions } });
  return user.toJSON();
}

// Disable with reassignment: open leads go to `reassignTo` or back to the
// manager queue (unassigned); sessions are revoked.
async function disable(id, { reason, reassignTo }, req) {
  const user = await staffOr404(id, req);
  const { Lead } = require('../../leads/models');
  let moved = 0;
  if (reassignTo) {
    const target = await User.findOne({ _id: reassignTo, role: { $in: ['agent', 'manager'] }, status: 'active' });
    if (!target) throw ApiError.badRequest('Reassignment target must be an active agent or manager', 'INVALID_REASSIGN');
  }
  const open = { assignedTo: user._id, stage: { $nin: ['closed_won', 'closed_lost'] } };
  const r = await Lead.updateMany(open, reassignTo
    ? { $set: { assignedTo: reassignTo, assignedAt: new Date() }, $push: { timeline: { type: 'assigned', by: req.user._id, data: { from: user._id, to: reassignTo, reason: 'staff_disabled' } } } }
    : { $unset: { assignedTo: 1 }, $push: { timeline: { type: 'unassigned', by: req.user._id, data: { from: user._id, reason: 'staff_disabled' } } } });
  moved = r.modifiedCount;
  user.status = 'disabled';
  await user.save();
  await sessions.revokeAll(user._id);
  await notifyUser({ user, event: 'auth.disabled', channels: ['email'], vars: { reason } });
  await audit(req, { action: 'staff.disable', entityType: 'User', entityId: user._id, reason, after: { leadsMoved: moved, reassignTo } });
  return { disabled: true, leadsMoved: moved };
}

async function reset2fa(id, req) {
  const user = await staffOr404(id, req);
  await auth.setOtpMethod(user._id, 'email', req, { actor: req.user });
  await audit(req, { action: 'staff.2fa_reset', entityType: 'User', entityId: user._id, reason: 'Identity checked by admin' });
  return { reset: true, method: 'email' };
}

async function forceLogout(id, req) {
  const user = await staffOr404(id, req, { allowSelf: true });
  await sessions.revokeAll(user._id);
  await audit(req, { action: 'staff.force_logout', entityType: 'User', entityId: user._id });
  return { loggedOut: true };
}

module.exports = { list, create, edit, disable, reset2fa, forceLogout, effectivePermissions };
