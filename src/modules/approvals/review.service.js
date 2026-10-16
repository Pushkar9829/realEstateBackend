// Module D - listing review queue and decisions (workflow D1), media
// moderation, admin listing actions and history (RE-D-01..05, 11, 12).
const { z } = require('zod');
const { Property } = require('../listings/models');
const { User } = require('../auth/models');
const listings = require('../listings/service');
const agreements = require('./agreements.service');
const kyc = require('../kyc/service');
const settings = require('../../core/settings');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { toPaise } = require('../../core/money');
const { notifyUser } = require('../notifications/service');

const CHECKLIST = ['photos_genuine', 'details_match', 'ownership_proof_matches_kyc', 'no_contact_info', 'commission_ok', 'location_ok'];
const BUILDER_CHECKLIST = ['rera_verified'];

const decisionSchema = z.object({
  decision: z.enum(['approve', 'changes', 'reject']),
  checklist: z.record(z.boolean()).optional(),
  proofOwnerName: z.string().trim().max(120).optional(), // name on the ownership proof (rule R1)
  comments: z.array(z.object({ field: z.string().max(60), comment: z.string().trim().min(2).max(500) })).optional(),
  reason: z.string().trim().max(500).optional(),
});

async function listQueue(query) {
  const filter = { deletedAt: null };
  if (query.queue === 'revisions') filter['pendingRevision.submittedAt'] = { $ne: null };
  else if (query.status) filter.status = { $in: String(query.status).split(',') };
  else filter.status = 'pending_approval';
  if (query.cityId) filter['location.cityId'] = query.cityId;
  if (query.listerId) filter.listerId = query.listerId;
  if (query.q) filter.$or = [{ listingNo: query.q }, { title: new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
  const sla = await settings.get('listing.reviewSlaHours');
  const { items, meta } = await paginate(Property, filter, { ...query, sort: query.sort || 'submittedAt' }, {
    projection: 'listingNo title purpose category type status location.city location.locality price.amount price.monthlyRent featured expiresAt updatedAt submittedAt warnings review.claimedBy review.claimUntil resubmissionCount pendingRevision.submittedAt listerId',
    populate: { path: 'listerId', select: 'name listerType kyc.status' },
  });
  const now = Date.now();
  items.forEach((i) => {
    const since = (i.pendingRevision && i.pendingRevision.submittedAt) || i.submittedAt;
    const age = since ? (now - new Date(since).getTime()) / 3600000 : 0;
    i.sla = { hours: sla, ageHours: Math.round(age), level: age >= sla ? 'red' : age >= 0.75 * sla ? 'amber' : 'green' };
  });
  return { items, meta };
}

async function fullView(id) {
  const p = await Property.findById(id).populate('listerId', 'name email phone listerType kyc.status kyc.legalName').populate('activeAgreementId').lean();
  if (!p) throw ApiError.notFound('Listing not found');
  return { ...p, checklist: CHECKLIST, builderChecklist: p.listerId && p.listerId.listerType === 'builder' ? BUILDER_CHECKLIST : [] };
}

async function propertyOr404(id) {
  const p = await Property.findById(id);
  if (!p || p.deletedAt) throw ApiError.notFound('Listing not found');
  return p;
}

async function claim(id, req) {
  const p = await propertyOr404(id);
  const reviewing = p.status === 'pending_approval' || (p.pendingRevision && p.pendingRevision.submittedAt);
  if (!reviewing) throw ApiError.conflict('Nothing to review on this listing', 'INVALID_TRANSITION');
  const now = new Date();
  if (p.review && p.review.claimUntil > now && String(p.review.claimedBy) !== String(req.user._id)) throw ApiError.conflict('Another reviewer is working on this listing', 'CLAIMED');
  const held = await Property.countDocuments({ 'review.claimedBy': req.user._id, 'review.claimUntil': { $gt: now }, _id: { $ne: p._id } });
  if (held >= 10) throw ApiError.conflict('Release some claims first (max 10)', 'CLAIM_LIMIT');
  p.review = { ...(p.review ? p.review.toObject() : {}), claimedBy: req.user._id, claimUntil: new Date(now.getTime() + (await settings.get('review.claimMinutes')) * 60000) };
  await p.save();
  return { claimedBy: req.user._id, claimUntil: p.review.claimUntil };
}

async function release(id, req) {
  const p = await propertyOr404(id);
  if (!p.review || String(p.review.claimedBy) !== String(req.user._id)) throw ApiError.conflict('You do not hold this claim', 'NOT_CLAIMED');
  p.review.claimedBy = undefined;
  p.review.claimUntil = undefined;
  await p.save();
  return { released: true };
}

function assertClaim(p, req) {
  if (!p.review || String(p.review.claimedBy) !== String(req.user._id) || !p.review.claimUntil || p.review.claimUntil < new Date()) {
    throw ApiError.conflict('Claim the listing before deciding', 'NOT_CLAIMED');
  }
}

// Approve gates (acceptance D1 / A4): KYC verified, >= min approved photos, active agreement, proof, RERA.
async function approveGates(p, lister) {
  const problems = [];
  if (!lister.kyc || lister.kyc.status !== 'verified') problems.push('Lister KYC is not verified');
  const minPhotos = await settings.get('media.minPhotos');
  if (p.media.photos.filter((ph) => ph.moderation.status === 'approved').length < minPhotos) problems.push(`At least ${minPhotos} approved photos are required`);
  if (!p.activeAgreementId) problems.push('No accepted commission agreement');
  if (lister.listerType !== 'builder' && !(p.media.ownershipProofs || []).length) problems.push('Ownership proof missing');
  if (lister.listerType === 'builder' && await settings.get('rera.requiredForBuilderListings')) {
    const r = p.rera || {};
    if (!((r.numbers || []).length && r.url) && !(r.exempt && r.exempt.reason)) problems.push('RERA registration or exemption missing');
  }
  return problems;
}

async function decide(id, body, req) {
  const d = decisionSchema.parse(body);
  const p = await propertyOr404(id);
  assertClaim(p, req);
  const lister = await User.findById(p.listerId);
  const isRevision = ['live', 'paused'].includes(p.status) && p.pendingRevision && p.pendingRevision.submittedAt;
  if (!isRevision && p.status !== 'pending_approval') throw ApiError.conflict(`A ${p.status} listing cannot be decided`, 'INVALID_TRANSITION');
  if (d.decision === 'changes' && !(d.comments && d.comments.length)) throw ApiError.validation([{ in: 'body', path: 'comments', message: 'Add at least one field comment' }]);
  if (d.decision === 'reject' && !d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'A reason is required' }]);

  if (d.decision === 'approve') {
    const required = [...CHECKLIST, ...(lister.listerType === 'builder' ? BUILDER_CHECKLIST : [])];
    const unticked = required.filter((k) => !(d.checklist && d.checklist[k]));
    if (unticked.length) throw ApiError.validation(unticked.map((k) => ({ in: 'body', path: `checklist.${k}`, message: 'Tick every checklist item' })));
    if (lister.status !== 'active' || ['suspended', 'banned'].includes(lister.kyc && lister.kyc.status)) {
      throw ApiError.conflict('The lister is suspended or inactive', 'LISTER_INACTIVE');
    }
    const problems = await approveGates(p, lister);
    if (problems.length) throw new ApiError(409, 'APPROVAL_BLOCKED', problems.join('; '), problems);
  }

  const now = new Date();
  const fromStatus = p.status; // audit before / after (RE-O-01 acceptance 1)
  p.review = { ...(p.review ? p.review.toObject() : {}), checklist: d.checklist, proofOwnerName: d.proofOwnerName || (p.review && p.review.proofOwnerName), reviewedBy: req.user._id, reviewedAt: now, claimedBy: undefined, claimUntil: undefined };
  p.reviewComments = d.comments ? d.comments.map((c) => ({ ...c, by: req.user._id, at: now })) : p.reviewComments;

  if (isRevision) {
    await decideRevision(p, d, lister, req);
  } else if (d.decision === 'approve') {
    listings.setStatus(p, 'live', req.user._id, 'Approved');
    p.liveAt = now;
    p.expiresAt = new Date(now.getTime() + (await listings.expiryDaysFor(p.purpose)) * 86400000);
    p.location.publicGeo = await listings.publicPoint(p);
    p.rejectionReason = undefined;
    await agreements.activate(p.activeAgreementId);
  } else if (d.decision === 'changes') {
    listings.setStatus(p, 'changes_requested', req.user._id, 'Changes requested');
  } else {
    listings.setStatus(p, 'rejected', req.user._id, d.reason);
    p.rejectionReason = d.reason;
  }
  await p.save();
  if (d.proofOwnerName) await kyc.checkProofOwners(lister); // rule R1
  await audit(req, { action: `listing.${isRevision ? 'revision.' : ''}${d.decision}`, entityType: 'Property', entityId: p._id, reason: d.reason, before: { status: fromStatus }, after: { status: p.status } });

  const vars = { listingNo: p.listingNo, title: p.title, propertyId: String(p._id), summary: (d.comments || []).map((c) => `${c.field}: ${c.comment}`).join('; '), reason: d.reason, expiresAt: p.expiresAt ? p.expiresAt.toDateString() : '' };
  const event = { approve: 'listing.approved', changes: 'listing.changes_requested', reject: 'listing.rejected' }[d.decision];
  await notifyUser({ user: lister, event, channels: d.decision === 'approve' ? ['in_app', 'email', 'sms'] : ['in_app', 'email'], vars });
  return { status: p.status, liveAt: p.liveAt, expiresAt: p.expiresAt };
}

// A2 step 4: approve merges the revision; changes / reject return or discard it.
async function decideRevision(p, d, lister, req) {
  const rev = p.pendingRevision;
  if (d.decision === 'approve') {
    const changes = rev.changes || {};
    for (const step of [1, 2, 3, 4, 5, 6]) {
      if (changes[step]) {
        const data = require('../listings/validators').steps[step].parse(changes[step]);
        await applyRevisionStep(p, step, data, lister);
      }
    }
    if (rev.agreementId) {
      await agreements.activate(rev.agreementId, p.activeAgreementId);
      p.activeAgreementId = rev.agreementId;
      p.commission = { percent: changes.commission.percent, acceptedAt: new Date() };
    }
    p.revisionNo = (p.revisionNo || 0) + 1;
    p.pendingRevision = undefined;
  } else if (d.decision === 'changes') {
    p.pendingRevision.submittedAt = undefined; // back to the lister, live version untouched
    p.markModified('pendingRevision');
  } else {
    if (rev.agreementId) await agreements.voidPending(rev.agreementId);
    p.pendingRevision = undefined;
  }
}

// Reuse the wizard rules (masters, price ranges, area normalisation) on the live document.
const applyRevisionStep = (p, step, data, lister) => listings.applyStep(p, step, data, lister, []);

const mediaSchema = z.object({ status: z.enum(['approved', 'rejected']), reason: z.string().trim().max(200).optional() });

async function moderateMedia(id, mediaId, body, req) {
  const d = mediaSchema.parse(body);
  if (d.status === 'rejected' && !d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'Give a reason for rejecting a photo' }]);
  const p = await propertyOr404(id);
  const photo = p.media.photos.id(mediaId);
  if (!photo) throw ApiError.notFound('Photo not found');
  photo.moderation = { status: d.status, reason: d.reason };
  await p.save();
  await audit(req, { action: 'listing.media_moderation', entityType: 'Property', entityId: p._id, after: { mediaId, ...d } });
  return photo;
}

const adminPatchSchema = z.object({
  action: z.enum(['feature', 'unfeature', 'extend', 'deactivate', 'suspend', 'pause', 'resume']),
  until: z.coerce.date().optional(),
  days: z.number().int().min(1).max(365).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});

async function adminAction(id, body, req) {
  const d = adminPatchSchema.parse(body);
  const p = await propertyOr404(id);
  const perms = req.user.role === 'superadmin' ? null : (req.user.permissions || []);
  if (perms && !perms.includes('properties.manage')) throw ApiError.forbidden('Missing permission: properties.manage', 'MISSING_PERMISSION');
  const needsReason = ['deactivate', 'suspend', 'pause'].includes(d.action);
  if (needsReason && !d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'A reason is required' }]);
  if (d.action === 'feature') p.featured = { on: true, until: d.until || new Date(Date.now() + 30 * 86400000) };
  if (d.action === 'unfeature') p.featured = { on: false };
  if (d.action === 'extend') {
    if (!['live', 'paused', 'expired'].includes(p.status)) throw ApiError.conflict('Only live, paused or expired listings can be extended', 'INVALID_TRANSITION');
    p.expiresAt = new Date(Math.max(Date.now(), (p.expiresAt || new Date()).getTime()) + (d.days || 30) * 86400000);
    if (p.status === 'expired') listings.setStatus(p, 'live', req.user._id, 'Extended by admin');
  }
  if (d.action === 'deactivate') { listings.setStatus(p, 'inactive', req.user._id, d.reason); p.inactiveReason = 'other'; }
  if (d.action === 'suspend') { p.suspendedFromStatus = p.status; listings.setStatus(p, 'suspended', req.user._id, d.reason); }
  if (d.action === 'pause') { listings.setStatus(p, 'paused', req.user._id, d.reason); p.pause = { reason: 'admin_review', note: d.reason, pausedAt: new Date(), by: req.user._id }; }
  if (d.action === 'resume') { await listings.resumeListing(p, req.user._id, { asAdmin: true }); }
  await p.save();
  await audit(req, { action: `listing.admin.${d.action}`, entityType: 'Property', entityId: p._id, reason: d.reason, after: { status: p.status, featured: p.featured, expiresAt: p.expiresAt } });
  return { status: p.status, featured: p.featured, expiresAt: p.expiresAt };
}

// RE-B-12: a listing's private files (ownership proofs, RERA certificate,
// exemption plan) are opened through 10-minute signed links; every view is audited.
async function fileUrl(id, fileId, req) {
  const p = await propertyOr404(id);
  const ids = [
    ...(p.media.ownershipProofs || []).map((f) => String(f.fileId)),
    p.rera && p.rera.certificateFileId && String(p.rera.certificateFileId),
    p.rera && p.rera.exempt && p.rera.exempt.docFileId && String(p.rera.exempt.docFileId),
  ].filter(Boolean);
  if (!ids.includes(String(fileId))) throw ApiError.notFound('File not found on this listing');
  const storage = require('../../core/storage');
  const file = await storage.FileModel.findById(fileId);
  if (!file) throw ApiError.notFound('File not found');
  await audit(req, { action: 'listing.file_view', entityType: 'Property', entityId: p._id, after: { fileId: String(fileId), purpose: file.purpose } });
  return { url: storage.urlFor(file, 600), expiresInSec: 600, mime: file.mime };
}

async function history(id) {
  const p = await Property.findById(id).select('listingNo statusHistory reviewComments pendingRevision revisionNo').lean();
  if (!p) throw ApiError.notFound('Listing not found');
  const { AuditLog } = require('../../core/audit');
  const auditTrail = await AuditLog.find({ entityType: 'Property', entityId: p._id }).sort({ at: -1 }).limit(200).lean();
  return { ...p, audit: auditTrail };
}

async function exportCsv(query, res) {
  const filter = { deletedAt: null };
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  const rows = await Property.find(filter).populate('listerId', 'name email listerType').limit(50000).lean();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['listingNo', 'status', 'purpose', 'category', 'type', 'title', 'city', 'locality', 'price', 'monthlyRent', 'commissionPercent', 'lister', 'listerType', 'liveAt', 'expiresAt'];
  const lines = rows.map((r) => [r.listingNo, r.status, r.purpose, r.category, r.type, r.title, r.location && r.location.city, r.location && r.location.locality,
    r.price && r.price.amount ? r.price.amount / 100 : '', r.price && r.price.monthlyRent ? r.price.monthlyRent / 100 : '', r.commission && r.commission.percent,
    r.listerId && r.listerId.name, r.listerId && r.listerId.listerType, r.liveAt && r.liveAt.toISOString(), r.expiresAt && r.expiresAt.toISOString()].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="listings.csv"');
  res.send([header.join(','), ...lines].join('\n'));
}

module.exports = {
  fileUrl, listQueue, fullView, claim, release, decide, moderateMedia, adminAction, history, exportCsv, CHECKLIST, BUILDER_CHECKLIST };
