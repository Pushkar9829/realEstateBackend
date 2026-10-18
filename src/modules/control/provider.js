// Real Estate specifics for the Control Center adapter (CC_CONTRACT.md 5.9).
// Money is integer paise. No personal data in ops payloads (reference numbers only).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const pkg = require('../../../package.json');
const ApiError = require('../../core/http/ApiError');
const { encrypt, decrypt } = require('../../core/security/crypto');
const { audit, securityEvent, AuditLog, SecurityEvent } = require('../../core/audit');
const tokens = require('../../core/security/jwt');
const settings = require('../../core/settings');
const Job = require('../../core/jobs/Job.model');
const Outbox = require('../../core/outbox/Outbox.model');
const { STAFF_ROLES, ADMIN_PANEL_ROLES } = require('../../constants/roles');
const { ALL_PERMISSIONS } = require('../../constants/permissions');

const m = {
  get User() { return require('../auth/models').User; },
  get RefreshToken() { return require('../auth/models').RefreshToken; },
  get DeletionRequest() { return require('../auth/models').DeletionRequest; },
  get Property() { return require('../listings/models').Property; },
  get VerificationSession() { return require('../listings/models').VerificationSession; },
  get Lead() { return require('../leads/models').Lead; },
  get Deal() { return require('../deals/models').Deal; },
  get Receivable() { return require('../receivables/models').Receivable; },
  get Project() { return require('../projects/models').Project; },
  get ListingReport() { return require('../search/models').ListingReport; },
};
const staffSvc = () => require('../auth/services/staff.service');
const sessions = () => require('../auth/services/session.service');

const inRange = (r) => ({ $gte: r.from, $lte: r.to });
const sum = async (model, pipeline) => ((await model.aggregate(pipeline))[0] || {}).v || 0;
const top = (rows, map) => rows.map(map);

async function health() {
  const now = new Date();
  const [queued, running, dead, oldest, pending, sent, outDead] = await Promise.all([
    Job.countDocuments({ status: 'queued', runAt: { $lte: now } }), Job.countDocuments({ status: 'running' }), Job.countDocuments({ status: 'dead' }),
    Job.findOne({ status: 'queued', runAt: { $lte: now } }).sort({ runAt: 1 }).select('runAt').lean(),
    Outbox.countDocuments({ status: 'pending' }), Outbox.countDocuments({ status: 'sent' }), Outbox.countDocuments({ status: 'dead' }),
  ]);
  return {
    jobs: { queued, running, dead, oldestQueuedSec: oldest ? Math.round((now - oldest.runAt) / 1000) : null },
    outbox: { pending, sent, failed: 0, dead: outDead },
  };
}

async function summary(r) {
  const { User, Property, Lead, Deal, Receivable } = m;
  const OPEN_REC = ['pending_invoice', 'invoiced', 'overdue', 'partially_paid'];
  const [live, newListings, leads, dealsClosed, commission, outstanding, received, newUsers, users, staff] = await Promise.all([
    Property.countDocuments({ status: 'live', deletedAt: null }),
    Property.countDocuments({ createdAt: inRange(r), deletedAt: null }),
    Lead.countDocuments({ createdAt: inRange(r) }),
    Deal.countDocuments({ status: 'verified', 'review.verifiedAt': inRange(r) }),
    sum(Deal, [{ $match: { status: 'verified', 'review.verifiedAt': inRange(r) } }, { $group: { _id: null, v: { $sum: '$commissionAmount' } } }]),
    sum(Receivable, [{ $match: { status: { $in: OPEN_REC } } }, { $group: { _id: null, v: { $sum: { $subtract: [{ $ifNull: ['$totalDue', 0] }, { $ifNull: ['$receivedAmount', 0] }] } } } }]),
    sum(Receivable, [{ $unwind: '$payments' }, { $match: { 'payments.status': 'confirmed', 'payments.confirmedAt': inRange(r) } }, { $group: { _id: null, v: { $sum: '$payments.amount' } } }]),
    User.countDocuments({ createdAt: inRange(r), role: { $in: ['buyer', 'lister'] } }),
    User.countDocuments({ role: { $in: ['buyer', 'lister'] } }),
    User.countDocuments({ role: { $in: STAFF_ROLES }, status: 'active' }),
  ]);
  return {
    kpis: [
      { key: 'listings_live', label: 'Listings live', value: live, unit: 'count' },
      { key: 'listings_new', label: 'New listings', value: newListings, unit: 'count' },
      { key: 'enquiries', label: 'New enquiries (leads)', value: leads, unit: 'count' },
      { key: 'deals_closed', label: 'Deals verified', value: dealsClosed, unit: 'count' },
      { key: 'commission', label: 'Commission earned', value: commission, unit: 'paise', revenue: true },
      { key: 'received', label: 'Payments received', value: received, unit: 'paise' },
      { key: 'receivables', label: 'Receivables outstanding', value: outstanding, unit: 'paise' },
      { key: 'new_users', label: 'New buyers and listers', value: newUsers, unit: 'count' },
    ],
    totals: { users, staff },
  };
}

async function queue(key, label, path, model, filter, item, sort = { updatedAt: 1 }) {
  const [count, rows] = await Promise.all([model.countDocuments(filter), model.find(filter).sort(sort).limit(5).lean()]);
  return { key, label, count, path, items: top(rows, item) };
}

async function approvals() {
  const { User, Property, VerificationSession, Deal, Project, ListingReport, DeletionRequest } = m;
  return Promise.all([
    queue('listing_review', 'Listing review', '/admin/approvals', Property, { status: 'pending_approval', deletedAt: null },
      (p) => ({ id: String(p._id), ref: p.listingNo, label: `Listing ${p.listingNo}`, since: p.submittedAt || p.updatedAt, path: `/admin/approvals/${p._id}` }), { submittedAt: 1 }),
    queue('lister_kyc', 'Lister KYC', '/admin/kyc', User, { role: 'lister', 'kyc.status': { $in: ['submitted', 'under_review'] } },
      (u) => ({ id: String(u._id), ref: `L-${String(u._id).slice(-6).toUpperCase()}`, label: `Lister L-${String(u._id).slice(-6).toUpperCase()}`, since: u.kyc && u.kyc.submittedAt, path: `/admin/kyc/${u._id}` })),
    queue('deal_verification', 'Deal verification', '/admin/deals', Deal, { status: { $in: ['submitted', 'under_review'] } },
      (d) => ({ id: String(d._id), ref: d.dealNo, label: `Deal ${d.dealNo}`, since: d.submittedAt, path: `/admin/deals/${d._id}` }), { submittedAt: 1 }),
    queue('project_review', 'Builder projects', '/admin/projects', Project, { status: 'pending_approval' },
      (p) => ({ id: String(p._id), ref: p.projectNo, label: `Project ${p.projectNo}`, since: p.updatedAt, path: `/admin/projects/${p._id}` })),
    queue('photo_verification', 'Photo verification', '/admin/photo-verification', VerificationSession, { status: 'pending_review' },
      (v) => ({ id: String(v._id), ref: `PV-${String(v._id).slice(-6).toUpperCase()}`, label: 'Photo verification', since: v.updatedAt, path: `/admin/photo-verification/${v._id}` })),
    queue('brand_changes', 'Builder brand changes', '/admin/listers', User, { role: 'lister', 'brand.pending.requestedAt': { $ne: null } },
      (u) => ({ id: String(u._id), ref: `L-${String(u._id).slice(-6).toUpperCase()}`, label: 'Brand change request', since: u.brand && u.brand.pending && u.brand.pending.requestedAt, path: `/admin/listers/${u._id}` })),
    queue('reported_listings', 'Reported listings', '/admin/feedback', ListingReport, { status: 'open' },
      (x) => ({ id: String(x._id), ref: `R-${String(x._id).slice(-6).toUpperCase()}`, label: 'Listing report', since: x.createdAt, path: '/admin/feedback' }), { createdAt: 1 }),
    queue('deletion_requests', 'Data deletion requests', '/admin/buyers', DeletionRequest, { status: { $in: ['requested', 'in_progress'] } },
      (x) => ({ id: String(x._id), ref: `DR-${String(x._id).slice(-6).toUpperCase()}`, label: 'Deletion request', since: x.createdAt, path: '/admin/buyers' }), { createdAt: 1 }),
  ]);
}

async function securityExtras() {
  const { User, RefreshToken } = m;
  const now = new Date();
  const [locked, families] = await Promise.all([
    User.countDocuments({ lockedUntil: { $gt: now } }),
    RefreshToken.distinct('familyId', { revokedAt: null, expiresAt: { $gt: now } }),
  ]);
  return { lockedAccounts: locked, activeSessions: families.length };
}

async function integrations() {
  const [byStatus, byType, oldest, failures, enabled] = await Promise.all([
    Outbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Outbox.aggregate([{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]),
    Outbox.findOne({ status: 'pending' }).sort({ createdAt: 1 }).select('createdAt').lean(),
    Outbox.find({ status: 'dead' }).sort({ updatedAt: -1 }).limit(10).select('eventId type status attempts lastError updatedAt').lean(),
    settings.get('mlm.enabled'),
  ]);
  const s = Object.fromEntries(byStatus.map((x) => [x._id, x.n]));
  const types = {};
  byType.forEach((x) => { types[x._id.type] = types[x._id.type] || { type: x._id.type, sent: 0, pending: 0, failed: 0, dead: 0, skipped: 0 }; types[x._id.type][x._id.status === 'skipped_unreferred' ? 'skipped' : x._id.status] = x.n; });
  return {
    hub: { configured: Boolean(env.MLM_ENGINE_URL && env.MLM_PLATFORM_KEY), enabled: Boolean(enabled), paused: await require('./state').isPaused('hub_delivery') },
    outbox: { pending: s.pending || 0, sent: s.sent || 0, failed: 0, dead: s.dead || 0, skipped: s.skipped_unreferred || 0, oldestPendingSec: oldest ? Math.round((Date.now() - oldest.createdAt) / 1000) : null },
    byType: Object.values(types),
    recentFailures: failures.map((f) => ({ eventId: f.eventId, type: f.type, status: f.status, attempts: f.attempts, lastError: String(f.lastError || '').slice(0, 200), at: f.updatedAt })),
  };
}

// ---- staff ----
const STAFF = ['agent', 'manager', 'admin', 'superadmin'];
const staff = {
  roles: STAFF,
  async list() {
    const { items } = await staffSvc().list({ limit: 100, page: 1, sort: 'name' });
    return items.map((u) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, status: u.status, lastLoginAt: u.lastLoginAt || null, twoFactor: (u.twoFactor && u.twoFactor.method) || 'email' }));
  },
  async invite(body, req) {
    if (!body.phone) throw ApiError.validation([{ in: 'body', path: 'phone', message: 'Real Estate staff need an Indian mobile number (+91...)' }]);
    const u = await staffSvc().create({ name: body.name, email: body.email.toLowerCase(), phone: body.phone, role: body.role, permissions: body.permissions || [] }, req);
    return { id: String(u._id), role: u.role, status: u.status };
  },
  setRole: (id, role, req) => staffSvc().edit(id, { role }, req).then((u) => ({ role: u.role })),
  disable: (id, { reason }, req) => staffSvc().disable(id, { reason }, req),
  enable: (id, req) => staffSvc().enable(id, req),
  forceLogout: (id, req) => staffSvc().forceLogout(id, req),
  reset2fa: (id, req) => staffSvc().reset2fa(id, req),
};

// ---- settings ----
const adminUsers = () => require('../auth/services/admin-users.service');
const settingsApi = {
  auditActions: ['settings.update'],
  async list() {
    const rows = await adminUsers().listSettings({ role: 'superadmin', permissions: [] });
    return rows.map((s) => ({ key: s.key, value: s.value, default: s.default, type: s.type, description: s.description, editable: s.edit !== 'env', permission: s.edit }));
  },
  async update({ key, value }, req) {
    const before = await settings.get(key).catch(() => { throw ApiError.notFound(`Unknown setting ${key}`); });
    await adminUsers().patchSettings(req.user, { changes: [{ key, value }] }, req);
    settings.clearCache();
    return { key, before, after: await settings.get(key) };
  },
};

// ---- SSO / linked accounts ----
async function uniquePhone(sub) {
  const { User } = m;
  for (let i = 0; i < 20; i += 1) {
    const digits = BigInt(`0x${crypto.createHash('sha256').update(`${sub}:${i}`).digest('hex').slice(0, 12)}`) % 1000000000n;
    const phone = `+910${String(digits).padStart(9, '0')}`; // +91 0xxxxxxxxx is not a dialable mobile number
    if (!(await User.exists({ phone }))) return phone;
  }
  throw new Error('Could not allocate a phone placeholder');
}

const permsFor = (role) => (role === 'admin' ? [...ALL_PERMISSIONS] : []);

const sso = {
  roles: ['superadmin', 'admin'],
  actorRoles: { owner: 'superadmin', group_admin: 'admin' },
  home: '/admin',
  findUser: (id) => m.User.findById(id).select('+permissions').lean(),
  async setRole(user, role) {
    await m.User.updateOne({ _id: user._id }, { $set: { role, permissions: permsFor(role), extraPermissions: permsFor(role) } });
    await sessions().revokeAll(user._id);
  },
  async createUser({ sub, name }, role) {
    const u = await m.User.create({
      name, email: `cc-${sub}@control-center.invalid`.toLowerCase(), phone: await uniquePhone(sub), role, status: 'active',
      emailVerified: true, phoneVerified: true, passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      permissions: permsFor(role), extraPermissions: permsFor(role), mustChangePassword: false,
    });
    return m.User.findById(u._id).select('+permissions').lean();
  },
  async startSession(user, req) {
    const doc = await m.User.findByIdAndUpdate(user._id, { $set: { lastLoginAt: new Date() } }, { new: true });
    const out = await sessions().start(doc, req, 'cc_sso');
    return { ...out, home: '/admin', mustChangePassword: false, user: doc.toJSON() };
  },
};

// Kill switches (B9): method + path rules on this platform's public API.
const flags = [
  { key: 'signups', label: 'New sign-ups', description: 'Buyer and lister registration', rules: [{ method: 'POST', path: /^\/api\/auth\/register$/ }] },
  { key: 'enquiries', label: 'Enquiries', description: 'New enquiries and contact forms from the public site', rules: [{ method: 'POST', path: /^\/api\/leads\/(enquiry|otp)(\/verify)?$/ }, { method: 'POST', path: /^\/api\/contact$/ }] },
  { key: 'hub_delivery', label: 'Hub delivery', description: 'Sending events to the Growth Hub (events wait in the outbox)', rules: [] },
];

async function isAdminRequest(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  try { return ADMIN_PANEL_ROLES.includes(tokens.verify(h.slice(7), 'access').role); } catch { return false; }
}

module.exports = {
  code: 'realestate',
  version: pkg.version,
  env: env.NODE_ENV,
  ApiError,
  encrypt,
  decrypt,
  audit: (req, entry) => audit(req, entry),
  securityEvent: (req, type, meta) => securityEvent(req, type, { meta }),
  models: { AuditLog, SecurityEvent },
  staffRoles: STAFF_ROLES,
  adminApiPrefixes: ['/api/admin'],
  isAdminRequest,
  health,
  summary,
  approvals,
  securityExtras,
  integrations,
  staff,
  settings: settingsApi,
  sso,
  flags,
};
