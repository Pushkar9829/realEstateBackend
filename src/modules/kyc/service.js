// Module F - Lister KYC, no-broker declaration, lister suspension / ban and
// broker flags (spec 4.6, workflows F1 and F2). Seeker flags (RE-F-10) need
// leads and arrive with the lead management phase.
const { z } = require('zod');
const { User } = require('../auth/models');
const { Master } = require('../cms/models');
const { Property } = require('../listings/models');
const { BrokerFlag, Blocklist } = require('./models');
const storage = require('../../core/storage');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const { ApiError, paginate } = require('../../core/http');
const { audit, securityEvent } = require('../../core/audit');
const { encrypt, sha256 } = require('../../core/security/crypto');
const { assertTransition } = require('../../constants/status');
const { notifyUser, notifyPermission } = require('../notifications/service');
const sessions = require('../auth/services/session.service');

const DECLARATION_STATEMENTS = [
  'I am the owner, builder or landlord of the properties I list, or legally authorised by them.',
  'I am not a broker, agent or intermediary and will not list properties of others for a fee.',
  'All enquiries for my listings are handled by the platform\'s sales team, and I will not share my contact details in listings.',
  'I agree to pay the commission I accept for each listing when a deal closes with a buyer introduced by the platform.',
];
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const idHash = (type, value) => sha256(`${type}:${String(value).trim().toLowerCase()}`);

// Dice coefficient on letter bigrams (0..1) for name similarity checks.
function nameSimilarity(a, b) {
  const grams = (s) => { const t = String(s || '').toLowerCase().replace(/[^a-z]/g, ''); const out = []; for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2)); return out; };
  const x = grams(a); const y = grams(b);
  if (!x.length || !y.length) return 0;
  const pool = [...y];
  let hits = 0;
  x.forEach((g) => { const i = pool.indexOf(g); if (i >= 0) { hits += 1; pool.splice(i, 1); } });
  return (2 * hits) / (x.length + y.length);
}

const schemas = {
  form: z.object({
    legalName: z.string().trim().min(2).max(120),
    dob: z.coerce.date().optional(),
    pan: z.string().trim().toUpperCase().regex(PAN, 'PAN must look like ABCDE1234F'),
    aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
    address: z.object({ line1: z.string().min(3).max(200), line2: z.string().max(200).optional(), city: z.string().min(2).max(60), state: z.string().min(2).max(60), pincode: z.string().regex(/^[1-9][0-9]{5}$/) }),
    company: z.object({ name: z.string().min(2).max(120), type: z.string().max(40).optional(), cin: z.string().max(30).optional(), gstin: z.string().regex(/^[0-9A-Z]{15}$/).optional(), rera: z.string().max(40).optional() }).optional(),
  }),
  document: z.object({ docType: z.string().min(2).max(40), fileId: z.string().regex(/^[a-f0-9]{24}$/) }),
  submit: z.object({ statements: z.array(z.literal(true)).length(4, 'All four statements must be accepted'), typedName: z.string().trim().min(2).max(120) }),
  decision: z.object({
    decision: z.enum(['verify', 'resubmit', 'reject']),
    comment: z.string().trim().max(1000).optional(),
    reason: z.string().trim().max(300).optional(),
    documents: z.array(z.object({ docId: z.string(), status: z.enum(['accepted', 'rejected']), comment: z.string().max(300).optional() })).optional(),
  }),
  status: z.object({ action: z.enum(['suspend', 'ban', 'reinstate']), reason: z.string().trim().min(3).max(500) }),
  limits: z.object({ listingLimit: z.number().int().min(0).max(10000).nullable() }),
  manualFlag: z.object({ listerId: z.string().regex(/^[a-f0-9]{24}$/), note: z.string().trim().min(5).max(1000) }),
  resolve: z.object({ resolution: z.enum(['dismiss', 'confirm_warn', 'confirm_suspend', 'confirm_ban']), note: z.string().trim().min(3).max(1000) }),
};

// ---------------------------------------------------------------- lister side (F1)

// Always loads the hidden PAN fields: saving a KYC subdocument that was read
// without them would otherwise drop them.
async function listerOr404(userId) {
  const u = await User.findOne({ _id: userId, role: 'lister' }).select('+kyc.panEnc +kyc.panHash');
  if (!u) throw ApiError.notFound('Lister not found');
  if (!u.kyc) u.kyc = { status: 'not_started' };
  return u;
}

async function requiredDocTypes(listerType) {
  const types = await Master.find({ type: 'doc_type', active: true, 'meta.appliesTo': listerType }).lean();
  return { all: types.map((t) => t.code), required: types.filter((t) => t.meta && t.meta.required).map((t) => t.code) };
}

function kycView(u) {
  const k = u.kyc.toObject ? u.kyc.toObject() : u.kyc;
  delete k.panEnc; delete k.panHash;
  return k;
}

async function getOwn(user) {
  const u = await listerOr404(user._id);
  return { kyc: kycView(u), listerType: u.listerType, declarationStatements: DECLARATION_STATEMENTS, documentTypes: await requiredDocTypes(u.listerType) };
}

const EDITABLE = ['not_started', 'resubmission_required', 'verified'];

async function saveForm(user, body, req) {
  const data = schemas.form.parse(body);
  if (user.listerType === 'builder' && !data.company) throw ApiError.validation([{ in: 'body', path: 'company', message: 'Company details are required for builders' }]);
  const u = await listerOr404(user._id);
  if (!EDITABLE.includes(u.kyc.status)) throw ApiError.conflict(`KYC cannot be edited while ${u.kyc.status.replace('_', ' ')}`, 'KYC_LOCKED');
  Object.assign(u.kyc, {
    legalName: data.legalName, dob: data.dob, address: data.address, aadhaarLast4: data.aadhaarLast4,
    panEnc: encrypt(data.pan), panLast4: data.pan.slice(-4), panHash: idHash('pan', data.pan),
    company: data.company ? { ...data.company } : u.kyc.company,
  });
  // RE-F-09: changed data on a verified account goes back to review (listings stay live).
  if (u.kyc.status === 'verified') {
    u.kyc.status = 'under_review';
    u.kyc.submittedAt = new Date();
    await notifyPermission('listers.verify', 'kyc.submitted', { name: u.name, listerType: u.listerType, userId: String(u._id) });
  }
  await u.save();
  await audit(req, { action: 'kyc.save', entityType: 'User', entityId: u._id });
  return kycView(u);
}

async function addDocument(user, body, req) {
  const { docType, fileId } = schemas.document.parse(body);
  const u = await listerOr404(user._id);
  if (!EDITABLE.includes(u.kyc.status)) throw ApiError.conflict(`KYC cannot be edited while ${u.kyc.status.replace('_', ' ')}`, 'KYC_LOCKED');
  const { all } = await requiredDocTypes(u.listerType);
  if (!all.includes(docType)) throw ApiError.validation([{ in: 'body', path: 'docType', message: `Use one of: ${all.join(', ')}` }]);
  const file = await storage.FileModel.findOne({ _id: fileId, ownerId: user._id, purpose: 'kyc_doc' });
  if (!file) throw ApiError.badRequest('Upload the file first (purpose kyc_doc)', 'FILE_NOT_FOUND');
  u.kyc.documents = (u.kyc.documents || []).filter((d) => d.docType !== docType); // one file per document type
  u.kyc.documents.push({ docType, fileId: file._id, hash: file.sha256, status: 'pending' });
  file.attachedTo = { type: 'UserKyc', id: u._id };
  await file.save();
  await u.save();
  return kycView(u);
}

async function removeDocument(user, docId) {
  const u = await listerOr404(user._id);
  if (!EDITABLE.includes(u.kyc.status)) throw ApiError.conflict('KYC cannot be edited now', 'KYC_LOCKED');
  const before = (u.kyc.documents || []).length;
  u.kyc.documents = (u.kyc.documents || []).filter((d) => String(d._id) !== docId);
  if (u.kyc.documents.length === before) throw ApiError.notFound('Document not found');
  await u.save();
  return kycView(u);
}

// Auto-checks shown to the reviewer (workflow F1 step 2).
async function autoChecks(u) {
  const checks = [];
  const sim = Math.max(nameSimilarity(u.kyc.legalName, u.name), nameSimilarity(u.kyc.legalName, u.kyc.declaration && u.kyc.declaration.typedName));
  if (sim < 0.8) checks.push({ code: 'name_mismatch', severity: 'warning', detail: `Profile / typed name similarity ${sim.toFixed(2)}` });
  const others = await User.find({ _id: { $ne: u._id }, 'kyc.panHash': u.kyc.panHash }).select('_id name').lean();
  if (others.length) checks.push({ code: 'pan_reused', severity: 'high', detail: `PAN also used by ${others.length} other account(s)` });
  const hashes = (u.kyc.documents || []).map((d) => d.hash).filter(Boolean);
  const dupFiles = hashes.length ? await storage.FileModel.find({ sha256: { $in: hashes }, purpose: 'kyc_doc', ownerId: { $ne: u._id } }).select('ownerId').lean() : [];
  const dupOwners = [...new Set(dupFiles.map((f) => String(f.ownerId)))];
  if (dupOwners.length) checks.push({ code: 'document_reused', severity: 'high', detail: `Same document file on ${dupOwners.length} other account(s)` });
  const blocked = await Blocklist.exists({ $or: [{ type: 'pan', valueHash: u.kyc.panHash }, { type: 'hash', valueHash: { $in: hashes } }] });
  if (blocked) checks.push({ code: 'blocklisted', severity: 'high', detail: 'PAN or a document matches a banned account' });
  return { checks, linkedAccounts: [...new Set([...others.map((o) => String(o._id)), ...dupOwners])] };
}

async function submit(user, body, req) {
  const { typedName } = schemas.submit.parse(body);
  const u = await listerOr404(user._id);
  const from = u.kyc.status;
  if (!['not_started', 'resubmission_required'].includes(from)) throw ApiError.conflict(`KYC is ${from.replace('_', ' ')}`, 'INVALID_TRANSITION');
  const maxResub = await settings.get('kyc.maxResubmissions');
  if (from === 'resubmission_required' && u.kyc.resubmissionCount >= maxResub) throw ApiError.conflict('Maximum resubmissions reached, contact support', 'RESUBMISSION_LIMIT');
  const missing = [];
  if (!u.kyc.legalName || !u.kyc.panHash || !u.kyc.address || !u.kyc.address.line1) missing.push('details');
  const { required } = await requiredDocTypes(u.listerType);
  const have = (u.kyc.documents || []).map((d) => d.docType);
  required.filter((r) => !have.includes(r)).forEach((r) => missing.push(`document:${r}`));
  if (missing.length) throw ApiError.validation(missing.map((m) => ({ in: 'body', path: m, message: 'Required before submitting' })), 'KYC is incomplete');

  u.kyc.declaration = { statements: DECLARATION_STATEMENTS, typedName, acceptedAt: new Date(), ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) };
  if (from === 'resubmission_required') u.kyc.resubmissionCount += 1;
  u.kyc.status = 'submitted';
  u.kyc.submittedAt = new Date();
  const { checks, linkedAccounts } = await autoChecks(u);
  u.kyc.autoChecks = checks;
  await u.save();
  if (linkedAccounts.length) await raiseFlag(u._id, 'R4', { linkedAccounts, checks: checks.filter((c) => c.severity === 'high') }); // shared identifiers
  await audit(req, { action: 'kyc.submit', entityType: 'User', entityId: u._id, after: { autoChecks: checks.map((c) => c.code) } });
  await notifyPermission('listers.verify', 'kyc.submitted', { name: u.name, listerType: u.listerType, userId: String(u._id) });
  return kycView(u);
}

// ---------------------------------------------------------------- admin review (F1)

async function queue(query) {
  const filter = { role: 'lister', 'kyc.status': query.status || { $in: ['submitted', 'under_review'] } };
  if (query.listerType) filter.listerType = query.listerType;
  const slaHours = await settings.get('kyc.reviewSlaHours');
  const { items, meta } = await paginate(User, filter, { ...query, sort: 'kyc.submittedAt' }, { projection: 'name email phone listerType kyc.status kyc.submittedAt kyc.claim kyc.autoChecks kyc.resubmissionCount' });
  const now = Date.now();
  items.forEach((i) => {
    const age = (now - new Date(i.kyc.submittedAt || now).getTime()) / 3600000;
    i.sla = { hours: slaHours, ageHours: Math.round(age), level: age >= slaHours ? 'red' : age >= 0.75 * slaHours ? 'amber' : 'green' };
  });
  return { items, meta };
}

async function detail(userId) {
  const u = await listerOr404(userId);
  const kyc = kycView(u);
  const files = await storage.FileModel.find({ _id: { $in: (kyc.documents || []).map((d) => d.fileId) } }).lean();
  kyc.documents = (kyc.documents || []).map((d) => {
    const f = files.find((x) => String(x._id) === String(d.fileId));
    return { ...d, mime: f && f.mime, sizeBytes: f && f.sizeBytes };
  });
  const listings = await Property.aggregate([{ $match: { listerId: u._id, deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  return { user: { _id: u._id, name: u.name, email: u.email, phone: u.phone, listerType: u.listerType, createdAt: u.createdAt }, kyc, listings };
}

async function documentUrl(userId, docId, req) {
  const u = await listerOr404(userId);
  const doc = (u.kyc.documents || []).find((d) => String(d._id) === docId);
  if (!doc) throw ApiError.notFound('Document not found');
  const file = await storage.FileModel.findById(doc.fileId);
  await audit(req, { action: 'kyc.document_view', entityType: 'User', entityId: u._id, after: { docType: doc.docType } }); // every view is logged
  return { url: storage.urlFor(file, 600), expiresInSec: 600, mime: file.mime };
}

async function claim(userId, req) {
  const u = await listerOr404(userId);
  const now = new Date();
  if (u.kyc.claim && u.kyc.claim.until > now && String(u.kyc.claim.by) !== String(req.user._id)) throw ApiError.conflict('Another reviewer is working on this KYC', 'CLAIMED');
  if (!['submitted', 'under_review'].includes(u.kyc.status)) throw ApiError.conflict(`KYC is ${u.kyc.status}`, 'INVALID_TRANSITION');
  const held = await User.countDocuments({ 'kyc.claim.by': req.user._id, 'kyc.claim.until': { $gt: now }, _id: { $ne: u._id } });
  if (held >= await settings.get('kyc.claimMaxPerReviewer')) throw ApiError.conflict('Release some claims first', 'CLAIM_LIMIT');
  u.kyc.status = 'under_review';
  u.kyc.claim = { by: req.user._id, until: new Date(now.getTime() + (await settings.get('review.claimMinutes')) * 60000) };
  await u.save();
  return { status: u.kyc.status, claim: u.kyc.claim };
}

async function release(userId, req) {
  const u = await listerOr404(userId);
  if (!u.kyc.claim || String(u.kyc.claim.by) !== String(req.user._id)) throw ApiError.conflict('You do not hold this claim', 'NOT_CLAIMED');
  u.kyc.claim = undefined;
  if (u.kyc.status === 'under_review') u.kyc.status = 'submitted';
  await u.save();
  return { status: u.kyc.status };
}

async function decide(userId, body, req) {
  const d = schemas.decision.parse(body);
  const u = await listerOr404(userId);
  if (u.kyc.status !== 'under_review' || !u.kyc.claim || String(u.kyc.claim.by) !== String(req.user._id) || u.kyc.claim.until < new Date()) {
    throw ApiError.conflict('Claim the KYC before deciding', 'NOT_CLAIMED');
  }
  if (d.decision === 'resubmit' && !d.comment) throw ApiError.validation([{ in: 'body', path: 'comment', message: 'Tell the lister what to fix' }]);
  if (d.decision === 'reject' && !d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'A reason is required' }]);
  (d.documents || []).forEach((dd) => {
    const doc = (u.kyc.documents || []).find((x) => String(x._id) === dd.docId);
    if (doc) { doc.status = dd.status; doc.comment = dd.comment; }
  });
  const to = { verify: 'verified', resubmit: 'resubmission_required', reject: 'rejected' }[d.decision];
  assertTransition('listerKyc', u.kyc.status, to);
  Object.assign(u.kyc, { status: to, reviewedBy: req.user._id, reviewedAt: new Date(), comment: d.comment, rejectReason: d.reason, claim: undefined });
  await u.save();
  await audit(req, { action: `kyc.${d.decision}`, entityType: 'User', entityId: u._id, reason: d.reason || d.comment });
  const event = { verify: 'kyc.verified', resubmit: 'kyc.resubmission_required', reject: 'kyc.rejected' }[d.decision];
  await notifyUser({ user: u, event, channels: d.decision === 'verify' ? ['in_app', 'email', 'sms'] : ['in_app', 'email'], vars: { comment: d.comment, reason: d.reason } });
  // Rejected after listings went live: suspend them (edge case in 4.1).
  if (d.decision === 'reject') await suspendListings(u._id, req);
  return kycView(u);
}

// ---------------------------------------------------------------- lister status (RE-F-07, RE-F-08)

const OPEN_LISTING = ['live', 'paused', 'pending_approval', 'changes_requested'];

async function suspendListings(listerId, req) {
  const items = await Property.find({ listerId, status: { $in: OPEN_LISTING } });
  for (const p of items) {
    p.statusHistory.push({ from: p.status, to: 'suspended', actor: req.user && req.user._id, note: 'Lister suspended' });
    p.suspendedFromStatus = p.status;
    p.status = 'suspended';
    await p.save();
  }
  return items.length;
}

async function restoreListings(listerId, req) {
  const items = await Property.find({ listerId, status: 'suspended' });
  let restored = 0;
  for (const p of items) {
    let to = p.suspendedFromStatus || 'inactive';
    if (['live', 'paused'].includes(to) && p.expiresAt && p.expiresAt < new Date()) to = 'expired';
    p.statusHistory.push({ from: 'suspended', to, actor: req.user && req.user._id, note: 'Lister reinstated' });
    p.status = to;
    p.suspendedFromStatus = undefined;
    await p.save();
    restored += 1;
  }
  return restored;
}

async function blocklistLister(u, reason, req) {
  const full = await User.findById(u._id).select('+kyc.panHash');
  const entries = [{ type: 'phone', valueHash: idHash('phone', full.phone) }, { type: 'email', valueHash: idHash('email', full.email) }];
  if (full.kyc && full.kyc.panHash) entries.push({ type: 'pan', valueHash: full.kyc.panHash });
  ((full.kyc && full.kyc.documents) || []).forEach((d) => d.hash && entries.push({ type: 'hash', valueHash: d.hash }));
  for (const e of entries) await Blocklist.updateOne({ type: e.type, valueHash: e.valueHash }, { $setOnInsert: { ...e, reason, addedBy: req.user && req.user._id } }, { upsert: true });
  return entries.length;
}

async function setListerStatus(listerId, body, req) {
  const { action, reason } = schemas.status.parse(body);
  const u = await listerOr404(listerId);
  const from = u.kyc.status;
  const to = { suspend: 'suspended', ban: 'banned', reinstate: 'verified' }[action];
  if (action === 'suspend' && from !== 'verified') throw ApiError.conflict('Only verified listers can be suspended', 'INVALID_TRANSITION');
  if (action === 'reinstate' && from !== 'suspended') throw ApiError.conflict('Only suspended listers can be reinstated', 'INVALID_TRANSITION');
  if (action === 'ban' && from === 'banned') throw ApiError.conflict('Already banned', 'INVALID_TRANSITION');
  u.kyc.status = to;
  await u.save();
  let listings = 0;
  if (action === 'reinstate') listings = await restoreListings(u._id, req);
  else listings = await suspendListings(u._id, req);
  if (action === 'ban') await blocklistLister(u, reason, req);
  await audit(req, { action: `lister.${action}`, entityType: 'User', entityId: u._id, before: { kycStatus: from }, after: { kycStatus: to, listings }, reason });
  await notifyUser({ user: u, event: { suspend: 'lister.suspended', ban: 'lister.banned', reinstate: 'lister.reinstated' }[action], channels: ['email', 'in_app'], vars: { reason } });
  return { kycStatus: to, listingsAffected: listings };
}

async function setListingLimit(listerId, body, req) {
  const { listingLimit } = schemas.limits.parse(body);
  const u = await listerOr404(listerId);
  const before = u.listingLimit;
  u.listingLimit = listingLimit === null ? undefined : listingLimit;
  await u.save();
  await audit(req, { action: 'lister.limit', entityType: 'User', entityId: u._id, before: { listingLimit: before }, after: { listingLimit } });
  return { listingLimit: u.listingLimit ?? null };
}

// Effective active-listing limit (null = unlimited).
async function listingLimitFor(user) {
  if (user.listingLimit !== undefined && user.listingLimit !== null) return user.listingLimit;
  const limits = await settings.get('listing.limits');
  return limits[user.listerType] ?? null;
}

function listListers(query) {
  const filter = { role: 'lister' };
  if (query.kycStatus) filter['kyc.status'] = query.kycStatus;
  if (query.listerType) filter.listerType = query.listerType;
  if (query.q) filter.$or = ['name', 'email', 'phone'].map((f) => ({ [f]: new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
  return paginate(User, filter, query, { projection: 'name email phone listerType kyc.status kyc.submittedAt listingLimit createdAt' });
}

async function listerDetail(id) {
  const base = await detail(id);
  base.flags = await BrokerFlag.find({ listerId: id }).sort({ createdAt: -1 }).lean();
  base.listingLimit = await listingLimitFor(await User.findById(id));
  return base;
}

// ---------------------------------------------------------------- broker flags (F2)

// One open flag per lister and rule; returns the flag (new or existing).
async function raiseFlag(listerId, rule, evidence) {
  const open = await BrokerFlag.findOne({ listerId, rule, status: { $in: ['open', 'under_review'] } });
  if (open) return open;
  const lister = await User.findById(listerId);
  const flag = await BrokerFlag.create({ flagNo: await counters.brokerFlagNo(), listerId, rule, evidence });
  await notifyPermission('listers.manage', 'broker.flag_raised', { flagNo: flag.flagNo, rule, listerName: lister ? lister.name : '', flagId: String(flag._id) }, ['in_app', 'email']);
  return flag;
}

// R2: active listings over the type limit (checked on listing submit).
async function checkListingLimit(lister) {
  const limit = await listingLimitFor(lister);
  if (limit === null) return null;
  const active = await Property.countDocuments({ listerId: lister._id, status: { $in: ['live', 'paused', 'pending_approval', 'changes_requested'] } });
  return active > limit ? raiseFlag(lister._id, 'R2', { active, limit }) : null;
}

// R3: the same photo (aHash) on listings of two or more different listers.
async function checkPhotoReuse(property) {
  const hashes = (property.media.photos || []).map((p) => p.hash).filter(Boolean);
  if (!hashes.length) return null;
  const others = await Property.find({ listerId: { $ne: property.listerId }, 'media.photos.hash': { $in: hashes }, deletedAt: null }).select('listingNo listerId').lean();
  return others.length ? raiseFlag(property.listerId, 'R3', { propertyId: property._id, matches: others.map((o) => ({ listingNo: o.listingNo, listerId: o.listerId })) }) : null;
}

// R1: ownership proofs naming more than N distinct owners within 90 days (owner / landlord).
async function checkProofOwners(lister) {
  if (lister.listerType === 'builder') return null;
  const since = new Date(Date.now() - 90 * 86400000);
  const names = await Property.distinct('review.proofOwnerName', { listerId: lister._id, 'review.proofOwnerName': { $ne: null }, updatedAt: { $gt: since } });
  const distinct = [...new Set(names.map((n) => String(n).trim().toLowerCase()))];
  return distinct.length > (await settings.get('broker.maxDistinctOwnersInProofs')) ? raiseFlag(lister._id, 'R1', { owners: distinct }) : null;
}

// R6: contact-info guard triggered 3+ times in 24 h.
async function checkGuardHits(userId) {
  const { SecurityEvent } = require('../../core/audit');
  const n = await SecurityEvent.countDocuments({ userId, type: 'guard.blocked', at: { $gt: new Date(Date.now() - 86400000) } });
  return n >= 3 ? raiseFlag(userId, 'R6', { hits24h: n }) : null;
}

function listFlags(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.rule) filter.rule = query.rule;
  if (query.listerId) filter.listerId = query.listerId;
  return paginate(BrokerFlag, filter, query, { populate: { path: 'listerId', select: 'name email listerType kyc.status' } });
}

async function flagDetail(id) {
  const f = await BrokerFlag.findById(id).populate('listerId', 'name email phone listerType kyc.status').lean();
  if (!f) throw ApiError.notFound('Flag not found');
  return f;
}

async function manualFlag(body, req) {
  const { listerId, note } = schemas.manualFlag.parse(body);
  await listerOr404(listerId);
  const flag = await raiseFlag(listerId, 'manual', { note, by: String(req.user._id) });
  await audit(req, { action: 'broker_flag.manual', entityType: 'BrokerFlag', entityId: flag._id, reason: note });
  return flag;
}

// Raised by an admin while actioning a reported listing (RE-E-13 -> RE-F-06).
// Rule 'reports' shares the open flag raised by repeated buyer reports; a
// later report is appended to its evidence instead of opening a second flag.
async function flagFromReport(report, property, note, req) {
  const entry = { reportId: String(report._id), reportNo: report.reportNo, reason: report.reason, propertyId: String(property._id), listingNo: property.listingNo, note, by: String(req.user._id), at: new Date() };
  const flag = await raiseFlag(property.listerId, 'reports', { source: 'admin_report', adminReports: [entry] });
  const ev = flag.evidence || {};
  const list = Array.isArray(ev.adminReports) ? ev.adminReports : [];
  if (!list.some((x) => x && x.reportId === entry.reportId)) {
    flag.evidence = { ...ev, adminReports: [...list, entry] };
    flag.markModified('evidence');
    await flag.save();
  }
  await audit(req, { action: 'broker_flag.from_report', entityType: 'BrokerFlag', entityId: flag._id, reason: note, after: { reportNo: report.reportNo, listingNo: property.listingNo } });
  return flag;
}

async function resolveFlag(id, body, req) {
  const { resolution, note } = schemas.resolve.parse(body);
  const f = await BrokerFlag.findById(id);
  if (!f) throw ApiError.notFound('Flag not found');
  if (!['open', 'under_review'].includes(f.status)) throw ApiError.conflict('Flag already resolved', 'INVALID_TRANSITION');
  f.status = 'resolved';
  f.resolution = { dismiss: 'cleared', confirm_warn: 'warned', confirm_suspend: 'suspended', confirm_ban: 'banned' }[resolution];
  Object.assign(f, { note, resolvedBy: req.user._id, resolvedAt: new Date() });
  await f.save();
  const lister = await User.findById(f.listerId);
  if (resolution === 'confirm_warn') await notifyUser({ user: lister, event: 'broker.warning', channels: ['email'], vars: { note } });
  if (resolution === 'confirm_suspend') await setListerStatus(f.listerId, { action: 'suspend', reason: `Broker flag ${f.flagNo}: ${note}` }, req);
  if (resolution === 'confirm_ban') await setListerStatus(f.listerId, { action: 'ban', reason: `Broker flag ${f.flagNo}: ${note}` }, req);
  await audit(req, { action: `broker_flag.${resolution}`, entityType: 'BrokerFlag', entityId: f._id, reason: note });
  return f;
}

// Registration / login guard (acceptance F4): banned phone or email.
async function isBlocked({ phone, email }) {
  const or = [];
  if (phone) or.push({ type: { $in: ['phone', 'seeker_phone'] }, valueHash: idHash('phone', phone) });
  if (email) or.push({ type: 'email', valueHash: idHash('email', email) });
  const hit = await Blocklist.findOne({ $or: or, $and: [{ $or: [{ until: null }, { until: { $gt: new Date() } }] }] });
  return Boolean(hit);
}

module.exports = {
  DECLARATION_STATEMENTS, nameSimilarity, idHash,
  getOwn, saveForm, addDocument, removeDocument, submit,
  queue, detail, documentUrl, claim, release, decide,
  setListerStatus, setListingLimit, listingLimitFor, listListers, listerDetail, suspendListings,
  raiseFlag, flagFromReport, checkListingLimit, checkPhotoReuse, checkProofOwners, checkGuardHits, listFlags, flagDetail, manualFlag, resolveFlag, isBlocked,
};
