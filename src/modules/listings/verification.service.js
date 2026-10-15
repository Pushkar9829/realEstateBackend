// RE-A-20 photo verification (workflow A6): the lister starts a session and
// gets a token link; someone at the property sends GPS (within 200 m of the
// exact pin, accuracy <= 100 m) and at least 4 live photos; QA approves and the
// "Photo verified" badge is granted for 180 days.
const crypto = require('crypto');
const { z } = require('zod');
const { Property, VerificationSession } = require('./models');
const { User } = require('../auth/models');
const storage = require('../../core/storage');
const { processImage } = require('../../core/media');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const env = require('../../config/env');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { distanceM } = require('../../core/geo');
const { notifyUser, notifyPermission } = require('../notifications/service');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function ownProperty(user, id) {
  const p = await Property.findOne({ _id: id, listerId: user._id, deletedAt: null });
  if (!p) throw ApiError.notFound('Listing not found');
  return p;
}

async function start(user, propertyId, req) {
  const s = await settings.all();
  if (!s['verification.photoEnabled']) throw ApiError.forbidden('Photo verification is switched off', 'FEATURE_DISABLED');
  const p = await ownProperty(user, propertyId);
  if (!['live', 'pending_approval', 'paused'].includes(p.status)) throw ApiError.conflict('Photo verification is for live or submitted listings', 'INVALID_STATE');
  if (!p.location || !p.location.geo) throw ApiError.conflict('Add the exact map pin first', 'NO_PIN');
  const since = new Date(Date.now() - 30 * 86400000);
  if (await VerificationSession.countDocuments({ propertyId: p._id, createdAt: { $gt: since } }) >= s['verification.maxAttemptsPer30Days']) {
    throw ApiError.conflict(`At most ${s['verification.maxAttemptsPer30Days']} attempts in 30 days`, 'ATTEMPT_LIMIT');
  }
  await VerificationSession.updateMany({ propertyId: p._id, status: 'open' }, { $set: { status: 'expired' } });
  const token = crypto.randomBytes(24).toString('base64url');
  const session = await VerificationSession.create({
    sessionNo: await counters.verificationNo(), propertyId: p._id, tokenHash: sha(token), createdBy: user._id,
    expiresAt: new Date(Date.now() + s['verification.linkValidHours'] * 3600000),
  });
  await audit(req, { action: 'verification.start', entityType: 'Property', entityId: p._id });
  return { sessionNo: session.sessionNo, link: `${env.CLIENT_URL}/verify-photos/${token}`, token, expiresAt: session.expiresAt };
}

async function badgeStatus(user, propertyId) {
  const p = await ownProperty(user, propertyId);
  const sessions = await VerificationSession.find({ propertyId: p._id }).sort({ createdAt: -1 }).limit(10).select('sessionNo status expiresAt createdAt review.decision review.reason review.comment photos').lean();
  const s = await settings.all();
  return {
    photo: p.verification && p.verification.photo,
    attempts: sessions.map((x) => ({ sessionNo: x.sessionNo, status: x.status, createdAt: x.createdAt, expiresAt: x.expiresAt, photos: (x.photos || []).length, reason: x.review && x.review.reason, comment: x.review && x.review.comment })),
    rules: { minPhotos: s['verification.minLivePhotos'], maxDistanceM: s['verification.photoMaxDistanceMeters'], maxAttemptsPer30Days: s['verification.maxAttemptsPer30Days'], validDays: s['verification.photoValidDays'] },
  };
}

async function sessionByToken(token, { open = true } = {}) {
  const session = await VerificationSession.findOne({ tokenHash: sha(token) });
  if (!session) throw ApiError.notFound('This link is not valid', 'TOKEN_INVALID');
  if (open) {
    if (session.status !== 'open') throw ApiError.conflict(session.status === 'pending_review' ? 'Already submitted. Our team reviews within 48 hours.' : 'This link can no longer be used', 'SESSION_CLOSED');
    if (session.expiresAt < new Date()) { session.status = 'expired'; await session.save(); throw ApiError.conflict('This link has expired. Ask the lister for a new one.', 'LINK_EXPIRED'); }
  }
  return session;
}

// Public view for the capture page: never the exact pin, only rules and the title.
async function capturePage(token) {
  const session = await sessionByToken(token, { open: false });
  const p = await Property.findById(session.propertyId).select('listingNo title location.locality location.city').lean();
  const s = await settings.all();
  return {
    status: session.expiresAt < new Date() && session.status === 'open' ? 'expired' : session.status,
    listing: { listingNo: p.listingNo, title: p.title, locality: p.location && p.location.locality, city: p.location && p.location.city },
    minPhotos: s['verification.minLivePhotos'], maxDistanceM: s['verification.photoMaxDistanceMeters'], photos: (session.photos || []).length,
    distanceM: session.gps && session.gps.distanceM, expiresAt: session.expiresAt,
  };
}

const gpsSchema = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), accuracy: z.coerce.number().min(0).max(100000) });

async function checkPoint(session, { lat, lng, accuracy }) {
  const s = await settings.all();
  if (accuracy > 100) throw ApiError.validation([{ in: 'body', path: 'accuracy', message: 'We need your precise location (accuracy within 100 m). Turn on GPS and try again.' }]);
  const p = await Property.findById(session.propertyId).select('location.geo').lean();
  const d = Math.round(distanceM({ type: 'Point', coordinates: [lng, lat] }, p.location.geo));
  if (d > s['verification.photoMaxDistanceMeters']) throw new ApiError(422, 'TOO_FAR', `You are about ${d} m from the property. Go to the property to take the photos.`, { distanceM: d });
  return d;
}

async function submitLocation(token, body) {
  const g = gpsSchema.parse(body);
  const session = await sessionByToken(token);
  const d = await checkPoint(session, g);
  session.gps = { lat: g.lat, lng: g.lng, accuracy: g.accuracy, distanceM: d };
  await session.save();
  return { distanceM: d, ok: true };
}

async function uploadPhoto(token, file, body) {
  const meta = gpsSchema.extend({ capturedAt: z.coerce.date() }).parse(body);
  const session = await sessionByToken(token);
  if (!session.gps || session.gps.distanceM == null) throw ApiError.conflict('Share your location first', 'LOCATION_REQUIRED');
  if (!file) throw ApiError.badRequest('Attach the photo in the "file" field', 'FILE_REQUIRED');
  if (meta.capturedAt < session.createdAt || meta.capturedAt > new Date(Date.now() + 120000)) throw ApiError.validation([{ in: 'body', path: 'capturedAt', message: 'Photos must be taken live during this session' }]);
  await checkPoint(session, meta);
  if ((session.photos || []).length >= 12) throw ApiError.badRequest('Up to 12 photos per session', 'PHOTO_LIMIT');
  const processed = await processImage(file, 'verification_photo');
  const p = await Property.findById(session.propertyId).select('listerId').lean();
  const saved = await storage.save(processed.file, { ownerId: p.listerId, purpose: 'verification_photo', meta: processed.meta, thumbnail: processed.thumbnail });
  session.photos.push({ fileId: saved._id, capturedAt: meta.capturedAt, lat: meta.lat, lng: meta.lng });
  await session.save();
  return { photos: session.photos.length };
}

async function submit(token, body) {
  const { addToGallery } = z.object({ addToGallery: z.boolean().default(false) }).parse(body || {});
  const session = await sessionByToken(token);
  const min = await settings.get('verification.minLivePhotos');
  if ((session.photos || []).length < min) throw ApiError.validation([{ in: 'body', path: 'photos', message: `Take at least ${min} photos` }]);
  session.status = 'pending_review';
  session.addToGallery = addToGallery;
  await session.save();
  await Property.updateOne({ _id: session.propertyId }, { $set: { 'verification.photo.status': 'pending', 'verification.photo.sessionId': session._id } });
  await notifyPermission('verification.review', 'verification.submitted', { sessionNo: session.sessionNo });
  return { status: 'pending_review' };
}

// ---------------------------------------------------------------- QA (RE-S-ADM-31)

async function qaQueue(query) {
  const filter = {};
  if (query.status === 'mine') { filter['review.claimedBy'] = query.userId; filter.status = 'pending_review'; } else filter.status = query.status || 'pending_review';
  const res = await paginate(VerificationSession, filter, { ...query, sort: query.sort || 'updatedAt' }, { populate: { path: 'propertyId', select: 'listingNo title location.city location.locality media.photos verification' } });
  const sla = await settings.get('verification.reviewSlaHours');
  res.items.forEach((x) => { const h = (Date.now() - new Date(x.updatedAt).getTime()) / 3600000; x.sla = { hours: sla, ageHours: Math.round(h), level: h >= sla ? 'red' : h >= 0.75 * sla ? 'amber' : 'green' }; delete x.tokenHash; });
  return res;
}

async function qaDetail(id) {
  const s = await VerificationSession.findById(id).select('-tokenHash').populate('propertyId', 'listingNo title location media.photos verification').lean();
  if (!s) throw ApiError.notFound('Session not found');
  const files = await storage.FileModel.find({ _id: { $in: (s.photos || []).map((x) => x.fileId) } }).lean();
  s.photos = (s.photos || []).map((x) => { const f = files.find((y) => String(y._id) === String(x.fileId)); return { ...x, url: f ? storage.urlFor(f, 600) : null }; });
  return s;
}

async function claim(id, req) {
  const s = await VerificationSession.findById(id);
  if (!s || s.status !== 'pending_review') throw ApiError.conflict('Nothing to review', 'INVALID_TRANSITION');
  if (s.review && s.review.claimUntil > new Date() && String(s.review.claimedBy) !== String(req.user._id)) throw ApiError.conflict('Another reviewer is working on this session', 'CLAIMED');
  s.review = { ...(s.review ? s.review.toObject() : {}), claimedBy: req.user._id, claimUntil: new Date(Date.now() + (await settings.get('review.claimMinutes')) * 60000) };
  await s.save();
  return s.review;
}

async function release(id, req) {
  const s = await VerificationSession.findById(id);
  if (!s || !s.review || String(s.review.claimedBy) !== String(req.user._id)) throw ApiError.conflict('You do not hold this claim', 'NOT_CLAIMED');
  s.review.claimedBy = undefined; s.review.claimUntil = undefined;
  await s.save();
  return { released: true };
}

const REJECT_REASONS = ['photos_do_not_match', 'location_mismatch', 'poor_quality', 'staged_or_screen', 'other'];

// addToGallery (approve only) overrides the lister's choice made on submit.
async function decide(id, body, req) {
  const d = z.object({ decision: z.enum(['approve', 'reject']), reason: z.enum(REJECT_REASONS).optional(), comment: z.string().trim().max(500).optional(), addToGallery: z.boolean().optional() }).parse(body);
  const s = await VerificationSession.findById(id);
  if (!s || s.status !== 'pending_review') throw ApiError.conflict('Nothing to review', 'INVALID_TRANSITION');
  if (!s.review || String(s.review.claimedBy) !== String(req.user._id) || s.review.claimUntil < new Date()) throw ApiError.conflict('Claim the session before deciding', 'NOT_CLAIMED');
  if (d.decision === 'reject' && (!d.reason || !d.comment || d.comment.length < 10)) throw ApiError.validation([{ in: 'body', path: 'comment', message: 'Give a reason and a comment of at least 10 characters' }]);
  const p = await Property.findById(s.propertyId);
  const validDays = await settings.get('verification.photoValidDays');
  const listerChoice = Boolean(s.addToGallery);
  if (d.decision === 'approve') {
    const now = new Date();
    p.verification.photo = { status: 'verified', sessionId: s._id, verifiedAt: now, expiresAt: new Date(now.getTime() + validDays * 86400000) };
    if (d.addToGallery !== undefined) s.addToGallery = d.addToGallery;
    if (s.addToGallery) {
      const files = await storage.FileModel.find({ _id: { $in: s.photos.map((x) => x.fileId) } });
      files.forEach((f) => p.media.photos.length < 20 && p.media.photos.push({ fileId: f._id, url: storage.urlFor(f), caption: 'Verified photo', sort: p.media.photos.length }));
    }
  } else {
    p.verification.photo = { ...(p.verification.photo || {}), status: 'rejected', sessionId: s._id };
  }
  s.status = d.decision === 'approve' ? 'approved' : 'rejected';
  s.review = { decision: d.decision, reason: d.reason, comment: d.comment, at: new Date() };
  await p.save();
  await s.save();
  await audit(req, { action: `verification.${d.decision}`, entityType: 'Property', entityId: p._id, reason: d.comment, after: d.decision === 'approve' ? { addToGallery: Boolean(s.addToGallery), listerChoice } : undefined });
  const lister = await User.findById(p.listerId);
  await notifyUser({ user: lister, event: d.decision === 'approve' ? 'verification.approved' : 'verification.rejected', channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, reason: d.comment || '' } });
  return { status: s.status, photo: p.verification.photo, addToGallery: d.decision === 'approve' ? Boolean(s.addToGallery) : undefined };
}

// Badges expire on their own; the job only flips the stored status for reports and filters.
async function expireBadges(now = new Date()) {
  const r = await Property.updateMany({ 'verification.photo.status': 'verified', 'verification.photo.expiresAt': { $lt: now } }, { $set: { 'verification.photo.status': 'expired' } });
  await VerificationSession.updateMany({ status: 'open', expiresAt: { $lt: now } }, { $set: { status: 'expired' } });
  return r.modifiedCount;
}

module.exports = { start, badgeStatus, capturePage, submitLocation, uploadPhoto, submit, qaQueue, qaDetail, claim, release, decide, expireBadges, REJECT_REASONS };
