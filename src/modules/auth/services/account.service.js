// Module M - my account (profile, sessions, login history) and RE-M-10 data
// rights: consent ledger, withdraw, data export, deletion requests.
const { User, LoginHistory, Consent, DeletionRequest } = require('../models');
const sessions = require('./session.service');
const { notifyUser } = require('../../notifications/service');
const { ApiError, paginate } = require('../../../core/http');
const storage = require('../../../core/storage');
const jobs = require('../../../core/jobs');
const settings = require('../../../core/settings');
const { audit } = require('../../../core/audit');

async function getMe(user) {
  const full = await User.findById(user._id).select('+permissions').lean();
  ['passwordHash', 'passwordHistory', 'inviteNonce'].forEach((k) => delete full[k]);
  if (full.kyc) delete full.kyc.panEnc;
  if (!['admin', 'superadmin', 'manager', 'agent'].includes(full.role)) delete full.permissions;
  return full;
}

async function updateMe(user, { name, avatarFileId, locale, billing }) {
  const full = await User.findById(user._id);
  if (name) full.name = name;
  if (locale) full.locale = locale;
  if (billing) {
    if (full.role !== 'lister') throw ApiError.badRequest('Billing details apply to listers only', 'NOT_A_LISTER');
    full.billing = { ...(full.billing ? full.billing.toObject() : {}), ...billing };
  }
  if (avatarFileId) {
    const file = await storage.FileModel.findOne({ _id: avatarFileId, ownerId: user._id, purpose: 'avatar' });
    if (!file) throw ApiError.badRequest('Avatar file not found', 'FILE_NOT_FOUND');
    full.avatar = storage.urlFor(file);
    file.attachedTo = { type: 'User', id: full._id };
    await file.save();
  }
  await full.save();
  return full.toJSON();
}

const listSessions = (user, sid) => sessions.list(user._id, sid);
const loginHistory = (user) => LoginHistory.find({ userId: user._id }).sort({ at: -1 }).limit(20).lean();

// ---------------------------------------------------------------- consents (DPDP Act 2023)

async function consents(user) {
  const rows = await Consent.find({ subjectType: 'user', subjectId: user._id }).sort({ givenAt: -1 }).lean();
  return { noticeVersion: await settings.get('privacy.noticeVersion'), grievanceOfficer: await settings.get('privacy.grievanceOfficer'), consents: rows };
}

async function withdrawConsent(user, purpose, req) {
  const r = await Consent.updateMany({ subjectType: 'user', subjectId: user._id, purpose, withdrawnAt: null }, { $set: { withdrawnAt: new Date() } });
  if (!r.modifiedCount) throw ApiError.notFound('No active consent for this purpose');
  await audit(req, { action: 'consent.withdraw', entityType: 'User', entityId: user._id, after: { purpose } });
  return { purpose, withdrawn: r.modifiedCount };
}

// Consents a signed-in user may give themselves (banner, account page). Sales contact and partner
// sharing are recorded by their own flows. Idempotent: an active consent is returned as is.
const SELF_GRANTABLE = ['analytics', 'whatsapp_updates', 'marketing_alerts'];
async function giveConsent(user, { purpose, source = 'banner' }, req) {
  if (!SELF_GRANTABLE.includes(purpose)) throw ApiError.badRequest('This consent is given through its own flow', 'CONSENT_NOT_SELF_GRANTABLE');
  const active = await Consent.findOne({ subjectType: 'user', subjectId: user._id, purpose, withdrawnAt: null });
  if (active) return active;
  const settings = require('../../../core/settings');
  const [doc] = await Consent.create([{ subjectType: 'user', subjectId: user._id, purpose, source, noticeVersion: await settings.get('privacy.noticeVersion'), ip: req.ip }]);
  await audit(req, { action: 'consent.give', entityType: 'User', entityId: user._id, after: { purpose, source } });
  return doc;
}

// Active consent check used by notification and lead modules.
const hasConsent = async (subjectId, purpose) => Boolean(await Consent.exists({ subjectId, purpose, withdrawnAt: null }));

async function requestDeletion(user, { reason }, req) {
  const open = await DeletionRequest.findOne({ userId: user._id, status: { $in: ['requested', 'in_progress'] } });
  if (open) throw ApiError.conflict('A deletion request is already open', 'DELETION_PENDING');
  const doc = await DeletionRequest.create({ userId: user._id, reason });
  await audit(req, { action: 'privacy.deletion_requested', entityType: 'User', entityId: user._id });
  await notifyUser({ user, event: 'privacy.deletion_received', channels: ['email'] });
  return doc;
}

async function requestDataExport(user, req) {
  const { ExportJob } = require('../../reports/models');
  const recent = await ExportJob.findOne({ requestedBy: user._id, kind: 'my_data', createdAt: { $gt: new Date(Date.now() - 86400000) } });
  if (recent) throw new ApiError(429, 'EXPORT_LIMIT', 'You can request one data export per day', { exportId: recent._id });
  const job = await ExportJob.create({ requestedBy: user._id, kind: 'my_data' });
  await jobs.enqueue('privacy.export', { exportId: String(job._id) });
  await audit(req, { action: 'privacy.export_requested', entityType: 'User', entityId: user._id });
  return { exportId: job._id, status: job.status };
}

// Latest "download my data" request (last 24 h) with a short-lived link once
// it is ready; the account page polls this while the job runs.
async function latestDataExport(user, req) {
  const { ExportJob } = require('../../reports/models');
  const job = await ExportJob.findOne({ requestedBy: user._id, kind: 'my_data', createdAt: { $gt: new Date(Date.now() - 86400000) } }).sort({ createdAt: -1 });
  if (!job) return null;
  const out = { exportId: job._id, status: job.status, requestedAt: job.createdAt, expiresAt: job.expiresAt, error: job.error };
  if (job.status === 'ready' && job.expiresAt && job.expiresAt < new Date()) return { ...out, status: 'expired' };
  if (job.status === 'ready') {
    const file = await storage.FileModel.findById(job.fileId);
    if (!file) return { ...out, status: 'expired' };
    await audit(req, { action: 'privacy.export_downloaded', entityType: 'User', entityId: user._id });
    return { ...out, url: storage.urlFor(file, 600) };
  }
  return out;
}

// Latest deletion request of the signed-in buyer / lister (or null).
const myDeletionRequest = (user) => DeletionRequest.findOne({ userId: user._id }).sort({ createdAt: -1 }).select('status reason note createdAt processedAt').lean();

// Job handler: collects the user's personal data into a private JSON file.
async function buildDataExport({ exportId }) {
  const { ExportJob } = require('../../reports/models');
  const job = await ExportJob.findById(exportId);
  if (!job || job.status !== 'queued') return;
  job.status = 'running';
  await job.save();
  const user = await User.findById(job.requestedBy).lean();
  const { Lead } = require('../../leads/models');
  const { Shortlist, SavedSearch } = require('../../search/models');
  const data = {
    generatedAt: new Date().toISOString(),
    profile: { name: user.name, email: user.email, phone: user.phone, role: user.role, listerType: user.listerType, createdAt: user.createdAt },
    consents: await Consent.find({ subjectId: user._id }).lean(),
    enquiries: await Lead.find({ 'buyer.userId': user._id }).select('leadNo stage sources requirement createdAt').lean(),
    shortlists: await Shortlist.find({ userId: user._id }).lean(),
    savedSearches: await SavedSearch.find({ userId: user._id }).lean(),
    loginHistory: await LoginHistory.find({ userId: user._id }).sort({ at: -1 }).limit(100).lean(),
  };
  const buffer = Buffer.from(JSON.stringify(data, null, 2));
  const file = await storage.save({ buffer, originalname: 'my-data.json', mimetype: 'application/json', size: buffer.length }, { ownerId: user._id, purpose: 'data_export' });
  Object.assign(job, { status: 'ready', fileId: file._id, rows: 1, expiresAt: new Date(Date.now() + 86400000) });
  await job.save();
  await notifyUser({ user, event: 'privacy.export_ready', channels: ['email', 'in_app'] });
}

// ---------------------------------------------------------------- admin views (users.manage)

const userConsents = (userId) => Consent.find({ subjectId: userId }).sort({ givenAt: -1 }).lean();

function deletionQueue(query) {
  const filter = query.status ? { status: query.status } : { status: { $in: ['requested', 'in_progress'] } };
  return paginate(DeletionRequest, filter, query, { populate: { path: 'userId', select: 'name email phone role' } });
}

module.exports = {
  getMe, updateMe, listSessions, loginHistory, consents, giveConsent, withdrawConsent, hasConsent,
  requestDeletion, requestDataExport, latestDataExport, myDeletionRequest, buildDataExport, userConsents, deletionQueue,
};
