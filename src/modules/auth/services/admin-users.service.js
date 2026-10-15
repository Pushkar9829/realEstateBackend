// Module M admin (RE-S-ADM-24/25): buyer and user accounts, block / unblock,
// anonymise (data rights, RE-M-10), deletion-request processing, and the
// platform settings editor (RE-S-ADM-29, each change audited before/after).
const { z } = require('zod');
const { User, DeletionRequest, RefreshToken } = require('../models');
const settings = require('../../../core/settings');
const { ApiError, paginate } = require('../../../core/http');
const { audit } = require('../../../core/audit');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PUBLIC_FIELDS = 'name email phone role listerType status createdAt lastLoginAt emailVerified phoneVerified referralCode referredBy anonymisedAt';

// ---------------------------------------------------------------- users

function list(query) {
  const filter = { role: { $in: query.role ? String(query.role).split(',') : ['buyer'] } };
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.q) {
    const rx = new RegExp(escapeRx(query.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  return paginate(User, filter, query, { projection: PUBLIC_FIELDS });
}

async function detail(id) {
  if (!oid.safeParse(String(id)).success) throw ApiError.notFound('User not found');
  const u = await User.findById(id).select(PUBLIC_FIELDS).lean();
  if (!u) throw ApiError.notFound('User not found');
  const { Lead } = require('../../leads/models');
  const [leads, deletion] = await Promise.all([
    Lead.find({ 'buyer.userId': u._id }).select('leadNo stage createdAt propertyId').sort({ createdAt: -1 }).limit(20).lean(),
    DeletionRequest.findOne({ userId: u._id }).sort({ createdAt: -1 }).lean(),
  ]);
  return { ...u, leads, deletionRequest: deletion };
}

const statusSchema = z.object({ status: z.enum(['active', 'blocked']), reason: z.string().trim().min(5).max(500) });

async function setStatus(id, body, req) {
  const d = statusSchema.parse(body);
  const u = await User.findById(id);
  if (!u) throw ApiError.notFound('User not found');
  if (['admin', 'superadmin', 'manager', 'agent'].includes(u.role)) throw ApiError.forbidden('Staff accounts are managed in Teams and staff', 'STAFF_ACCOUNT');
  if (u.status === 'anonymised') throw ApiError.conflict('This account is anonymised', 'ANONYMISED');
  const before = u.status;
  u.status = d.status;
  await u.save();
  if (d.status === 'blocked') await RefreshToken.updateMany({ userId: u._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await audit(req, { action: `user.${d.status === 'blocked' ? 'block' : 'unblock'}`, entityType: 'User', entityId: u._id, before: { status: before }, after: { status: d.status }, reason: d.reason });
  return { _id: u._id, status: u.status };
}

// Personal data replaced by placeholders; ids, dates and amounts stay for reports.
async function anonymise(id, body, req) {
  const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(body || {});
  const u = await User.findById(id);
  if (!u) throw ApiError.notFound('User not found');
  if (u.role !== 'buyer') throw ApiError.forbidden('Only buyer accounts can be anonymised here', 'NOT_A_BUYER');
  if (u.status === 'anonymised') throw ApiError.conflict('Already anonymised', 'ANONYMISED');
  const { Lead, BuyerContact } = require('../../leads/models');
  const { Deal } = require('../../deals/models');
  const leadIds = (await Lead.find({ 'buyer.userId': u._id }).select('_id').lean()).map((l) => l._id);
  if (await Deal.exists({ leadId: { $in: leadIds }, status: { $in: ['draft', 'submitted', 'under_review', 'returned'] } })) {
    throw ApiError.conflict('The buyer has an open deal; finish or cancel it first', 'OPEN_DEAL');
  }
  const tag = String(u._id);
  Object.assign(u, { name: 'Anonymised user', email: `anon-${tag}@deleted.invalid`, phone: `anon:${tag}`, status: 'anonymised', anonymisedAt: new Date() });
  await u.save();
  await RefreshToken.updateMany({ userId: u._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await Lead.updateMany({ 'buyer.userId': u._id }, { $set: { 'buyer.name': 'Buyer anonymised', 'buyer.phone': null, 'buyer.email': null, anonymisedAt: new Date() } });
  await BuyerContact.updateMany({ userId: u._id }, { $set: { name: 'Buyer anonymised', email: null, phone: `anon:${tag}` } });
  await DeletionRequest.updateMany({ userId: u._id, status: { $in: ['requested', 'in_progress'] } }, { $set: { status: 'completed', processedBy: req.user._id, processedAt: new Date(), note: reason } });
  await audit(req, { action: 'user.anonymise', entityType: 'User', entityId: u._id, reason, after: { leads: leadIds.length } });
  return { _id: u._id, status: u.status, leads: leadIds.length };
}

const decisionSchema = z.object({ status: z.enum(['in_progress', 'completed', 'rejected']), note: z.string().trim().min(5).max(1000) });

async function decideDeletion(id, body, req) {
  const d = decisionSchema.parse(body);
  const r = await DeletionRequest.findById(id);
  if (!r) throw ApiError.notFound('Request not found');
  if (['completed', 'rejected'].includes(r.status)) throw ApiError.conflict(`The request is already ${r.status}`, 'REQUEST_CLOSED');
  if (d.status === 'completed') {
    await anonymise(r.userId, { reason: d.note }, req);
    return DeletionRequest.findById(id).lean();
  }
  Object.assign(r, { status: d.status, note: d.note, processedBy: req.user._id, processedAt: new Date() });
  await r.save();
  await audit(req, { action: `privacy.deletion_${d.status}`, entityType: 'DeletionRequest', entityId: r._id, reason: d.note });
  return r;
}

// ---------------------------------------------------------------- settings

const canEdit = (user, edit) => user.role === 'superadmin' || (edit !== 'super admin only' && (user.permissions || []).includes(edit));
const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

async function listSettings(user) {
  const values = await settings.all();
  return settings.describe().map((s) => ({ ...s, value: values[s.key], type: kind(s.default), editable: canEdit(user, s.edit) }));
}

// Body: { changes: [{ key, value }] }. (Dotted keys cannot be object keys: the
// NoSQL-injection sanitizer strips them from request bodies.)
async function patchSettings(user, rawBody, req) {
  const { changes } = z.object({ changes: z.array(z.object({ key: z.string().min(1).max(80), value: z.any() })).min(1).max(100) }).parse(rawBody || {});
  const body = Object.fromEntries(changes.map((c) => [c.key, c.value]));
  const meta = Object.fromEntries(settings.describe().map((s) => [s.key, s]));
  const errors = [];
  for (const [key, value] of Object.entries(body)) {
    const m = meta[key];
    if (!m) errors.push({ in: 'body', path: key, message: 'Unknown setting' });
    else if (!canEdit(user, m.edit)) errors.push({ in: 'body', path: key, message: `Needs ${m.edit}` });
    else if (m.default !== null && kind(value) !== kind(m.default)) errors.push({ in: 'body', path: key, message: `Expected a ${kind(m.default)}` });
    else if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) errors.push({ in: 'body', path: key, message: 'Expected a number of 0 or more' });
  }
  if (errors.length) {
    if (errors.every((e) => /^Needs /.test(e.message))) throw ApiError.forbidden(errors.map((e) => `${e.path}: ${e.message}`).join('; '), 'MISSING_PERMISSION');
    throw ApiError.validation(errors);
  }
  const before = await settings.all();
  for (const [key, value] of Object.entries(body)) {
    await settings.set(key, value, user._id);
    await audit(req, { action: 'settings.update', entityType: 'Setting', before: { [key]: before[key] }, after: { [key]: value } });
  }
  return listSettings(user);
}

module.exports = { list, detail, setStatus, anonymise, decideDeletion, listSettings, patchSettings };
