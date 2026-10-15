// RE-D-13 site verification visits (workflow D4, Could). A lister asks for a
// visit or an admin (verification.schedule) creates one; an in-house agent with
// verification.field visits, captures GPS, ticks the checklist and uploads 4-20
// photos. "verified" grants the Site verified badge for verification.siteValidDays.
const { z } = require('zod');
const { VerificationVisit } = require('./models');
const { Property } = require('../listings/models');
const { User } = require('../auth/models');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const storage = require('../../core/storage');
const { distanceM } = require('../../core/geo');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { assertTransition } = require('../../constants/status');
const { notifyUser, notifyPermission } = require('../notifications/service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const OPEN = ['requested', 'scheduled'];
const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const has = (u, p) => u.role === 'superadmin' || (u.permissions || []).includes(p);

function move(v, to, by, note) {
  assertTransition('verificationVisit', v.status, to);
  v.history.push({ from: v.status, to, by, note });
  v.status = to;
}

async function assertOffered(p) {
  const [enabled, cities] = await Promise.all([settings.get('verification.siteVisitEnabled'), settings.get('verification.siteVisitCities')]);
  if (!enabled) throw ApiError.conflict('Site verification visits are not offered yet', 'FEATURE_DISABLED');
  const city = p.location && p.location.city;
  if (cities.length && !cities.some((c) => c.toLowerCase() === String(city || '').toLowerCase())) throw ApiError.conflict(`Site visits are not offered in ${city} yet`, 'CITY_NOT_OFFERED');
  if (!['live', 'pending_approval'].includes(p.status)) throw ApiError.conflict('Only live or pending listings can be site verified', 'LISTING_STATUS');
}

async function assertNoOpen(propertyId) {
  const open = await VerificationVisit.findOne({ propertyId, status: { $in: OPEN } }).select('visitNo').lean();
  if (open) throw ApiError.conflict(`Visit ${open.visitNo} is already open for this listing`, 'VISIT_OPEN');
}

// ---------------------------------------------------------------- lister

const requestSchema = z.object({ note: z.string().trim().max(500).optional() });

async function listerRequest(user, propertyId, body, req) {
  const d = requestSchema.parse(body || {});
  const p = await Property.findOne({ _id: propertyId, listerId: user._id, deletedAt: null });
  if (!p) throw ApiError.notFound('Listing not found');
  await assertOffered(p);
  await assertNoOpen(p._id);
  const v = await VerificationVisit.create({ visitNo: await counters.verificationVisitNo(), propertyId: p._id, listerId: p.listerId, requestedBy: user._id, status: 'requested', notes: d.note, history: [{ from: null, to: 'requested', by: user._id, note: 'Requested by lister' }] });
  await audit(req, { action: 'verification_visit.request', entityType: 'VerificationVisit', entityId: v._id });
  await notifyPermission('verification.schedule', 'verification_visit.requested', { visitNo: v.visitNo, listingNo: p.listingNo });
  return { _id: v._id, visitNo: v.visitNo, status: v.status };
}

// ---------------------------------------------------------------- admin

async function list(user, query, { ownOnly = false } = {}) {
  const filter = {};
  if (ownOnly || !has(user, 'verification.schedule')) filter.executiveId = user._id; // visiting agents see only their own
  else if (query.executiveId) filter.executiveId = query.executiveId;
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.from || query.to) filter.scheduledAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  return paginate(VerificationVisit, filter, { sort: '-createdAt', ...query }, {
    projection: '-history', populate: [{ path: 'propertyId', select: 'listingNo title status location.city location.locality location.addressLine' }, { path: 'executiveId', select: 'name' }],
  });
}

async function executiveOr422(id) {
  const u = await User.findOne({ _id: id, status: 'active', role: { $in: ['agent', 'manager'] } }).select('+permissions');
  if (!u || !(u.permissions || []).includes('verification.field')) throw ApiError.validation([{ in: 'body', path: 'executiveId', message: 'Pick an in-house agent with field verification access' }]);
  return u;
}

async function slotOr422(p, at, overrideReason) {
  const { checkSlot } = require('../leads/slots.service');
  const r = await checkSlot(at, { listerId: p.listerId, propertyId: p._id }, { ignoreNotice: true });
  if (!r.ok && !overrideReason) throw ApiError.validation([{ in: 'body', path: 'scheduledAt', message: r.reason }], r.reason);
}

const scheduleSchema = z.object({
  visitId: oid.optional(),
  propertyId: oid.optional(),
  scheduledAt: z.coerce.date(),
  executiveId: oid,
  notes: z.string().trim().max(1000).optional(),
  overrideReason: z.string().trim().min(5).max(300).optional(),
}).refine((d) => d.visitId || d.propertyId, 'Pick a requested visit or a listing');

async function notifyScheduled(v, p, executive, event = 'verification_visit.scheduled') {
  const lister = await User.findById(v.listerId);
  const vars = { visitNo: v.visitNo, listingNo: p.listingNo, when: fmt(v.scheduledAt) };
  if (lister) await notifyUser({ user: lister, event, vars, channels: ['in_app', 'email'] });
  if (executive) await notifyUser({ user: executive, event: 'verification_visit.assigned', vars: { ...vars, address: (p.location && p.location.addressLine) || '' } });
}

async function schedule(user, body, req) {
  const d = scheduleSchema.parse(body);
  if (d.scheduledAt < new Date()) throw ApiError.validation([{ in: 'body', path: 'scheduledAt', message: 'Pick a future date and time' }]);
  let v;
  if (d.visitId) {
    v = await VerificationVisit.findById(d.visitId);
    if (!v) throw ApiError.notFound('Visit not found');
    if (v.status !== 'requested') throw ApiError.conflict(`A ${v.status.replace('_', ' ')} visit cannot be scheduled here`, 'INVALID_TRANSITION');
  }
  const p = await Property.findById(v ? v.propertyId : d.propertyId);
  if (!p) throw ApiError.notFound('Listing not found');
  await assertOffered(p);
  if (!v) await assertNoOpen(p._id);
  const executive = await executiveOr422(d.executiveId);
  await slotOr422(p, d.scheduledAt, d.overrideReason);
  if (!v) v = new VerificationVisit({ visitNo: await counters.verificationVisitNo(), propertyId: p._id, listerId: p.listerId, requestedBy: user._id, status: 'requested', history: [{ from: null, to: 'requested', by: user._id, note: 'Created by admin' }] });
  move(v, 'scheduled', user._id, `For ${fmt(d.scheduledAt)}`);
  Object.assign(v, { scheduledAt: d.scheduledAt, executiveId: executive._id, notes: d.notes || v.notes, overrideReason: d.overrideReason });
  await v.save();
  p.verification.site = { ...(p.verification.site && p.verification.site.toObject ? p.verification.site.toObject() : {}), status: p.verification.site && p.verification.site.status === 'verified' ? 'verified' : 'scheduled', visitId: v._id };
  await p.save();
  await audit(req, { action: 'verification_visit.schedule', entityType: 'VerificationVisit', entityId: v._id, after: { scheduledAt: d.scheduledAt, executiveId: executive._id, overrideReason: d.overrideReason } });
  await notifyScheduled(v, p, executive);
  return v;
}

const patchSchema = z.object({ scheduledAt: z.coerce.date().optional(), executiveId: oid.optional(), notes: z.string().trim().max(1000).optional(), overrideReason: z.string().trim().min(5).max(300).optional() });

async function patch(user, id, body, req) {
  const d = patchSchema.parse(body);
  const v = await VerificationVisit.findById(id);
  if (!v) throw ApiError.notFound('Visit not found');
  const p = await Property.findById(v.propertyId);
  if (v.status === 'lister_absent') {
    if (v.absentReschedules >= 1) throw ApiError.conflict('A visit can be rescheduled only once after the lister was absent', 'RESCHEDULE_LIMIT');
    if (!d.scheduledAt) throw ApiError.validation([{ in: 'body', path: 'scheduledAt', message: 'Pick the new date' }]);
    v.absentReschedules += 1;
  } else if (v.status !== 'scheduled') throw ApiError.conflict(`A ${v.status.replace('_', ' ')} visit cannot be changed`, 'INVALID_TRANSITION');
  let executive = null;
  if (d.executiveId) { executive = await executiveOr422(d.executiveId); v.executiveId = executive._id; }
  if (d.scheduledAt) {
    if (d.scheduledAt < new Date()) throw ApiError.validation([{ in: 'body', path: 'scheduledAt', message: 'Pick a future date and time' }]);
    await slotOr422(p, d.scheduledAt, d.overrideReason);
    v.scheduledAt = d.scheduledAt;
    move(v, 'scheduled', user._id, `Rescheduled to ${fmt(d.scheduledAt)}`);
  }
  if (d.notes !== undefined) v.notes = d.notes;
  await v.save();
  await audit(req, { action: 'verification_visit.update', entityType: 'VerificationVisit', entityId: v._id, after: d });
  if (d.scheduledAt || executive) await notifyScheduled(v, p, executive || await User.findById(v.executiveId), 'verification_visit.rescheduled');
  return v;
}

const cancelSchema = z.object({ reason: z.string().trim().min(5).max(500) });

async function cancel(user, id, body, req, { listerId } = {}) {
  const { reason } = cancelSchema.parse(body);
  const v = await VerificationVisit.findOne({ _id: id, ...(listerId ? { listerId } : {}) });
  if (!v) throw ApiError.notFound('Visit not found');
  move(v, 'cancelled', user._id, reason);
  v.cancelReason = reason;
  await v.save();
  await Property.updateOne({ _id: v.propertyId, 'verification.site.visitId': v._id, 'verification.site.status': 'scheduled' }, { $set: { 'verification.site.status': 'none' } });
  await audit(req, { action: 'verification_visit.cancel', entityType: 'VerificationVisit', entityId: v._id, reason });
  const p = await Property.findById(v.propertyId).select('listingNo');
  const lister = await User.findById(v.listerId);
  if (lister && !listerId) await notifyUser({ user: lister, event: 'verification_visit.cancelled', vars: { visitNo: v.visitNo, listingNo: p.listingNo, reason } });
  if (v.executiveId) { const ex = await User.findById(v.executiveId); if (ex) await notifyUser({ user: ex, event: 'verification_visit.cancelled', vars: { visitNo: v.visitNo, listingNo: p.listingNo, reason } }); }
  return { status: v.status };
}

// ---------------------------------------------------------------- visiting agent

const CHECKLIST = ['existsAtPin', 'matchesPhotos', 'matchesDetails', 'ownerPresentWithId', 'noBrokerBoard'];
const outcomeSchema = z.object({
  result: z.enum(['verified', 'not_verified', 'lister_absent', 'cancelled']),
  checklist: z.object(Object.fromEntries(CHECKLIST.map((k) => [k, z.boolean().optional()]))).default({}),
  photoFileIds: z.array(oid).max(20).default([]),
  gps: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), accuracy: z.coerce.number().min(0).max(5000).optional() }).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

const own = (user, query) => list(user, query, { ownOnly: true });

async function outcome(user, id, body, req) {
  const d = outcomeSchema.parse(body);
  const v = await VerificationVisit.findOne({ _id: id, executiveId: user._id });
  if (!v) throw ApiError.notFound('Visit not found');
  if (v.status !== 'scheduled') throw ApiError.conflict(`A ${v.status.replace('_', ' ')} visit has its outcome already`, 'INVALID_TRANSITION');
  if (v.scheduledAt > new Date()) throw ApiError.conflict('The outcome can be recorded once the visit has started', 'VISIT_NOT_STARTED');
  const p = await Property.findById(v.propertyId);
  if (['verified', 'not_verified'].includes(d.result)) {
    const errs = [];
    if (!d.gps) errs.push({ in: 'body', path: 'gps', message: 'Capture GPS on arrival' });
    if (d.photoFileIds.length < 4) errs.push({ in: 'body', path: 'photoFileIds', message: 'Upload at least 4 photos' });
    if (d.result === 'verified' && CHECKLIST.some((k) => d.checklist[k] !== true)) errs.push({ in: 'body', path: 'checklist', message: 'Every checklist item must pass for a verified result' });
    if (errs.length) throw ApiError.validation(errs);
    const files = await storage.FileModel.find({ _id: { $in: d.photoFileIds }, ownerId: user._id, purpose: 'verification_photo' }).select('_id');
    if (files.length !== d.photoFileIds.length) throw ApiError.badRequest('Upload the photos first (purpose verification_photo)', 'FILE_NOT_FOUND');
    await storage.FileModel.updateMany({ _id: { $in: d.photoFileIds } }, { $set: { attachedTo: { type: 'VerificationVisit', id: v._id } } });
  }
  if (d.gps) {
    const pin = p.location && p.location.geo && p.location.geo.coordinates;
    const dist = pin ? distanceM({ coordinates: [d.gps.lng, d.gps.lat] }, { coordinates: pin }) : null;
    v.arrivalGps = { ...d.gps, distanceM: dist };
    const max = await settings.get('verification.photoMaxDistanceMeters');
    if (d.result === 'verified' && dist !== null && dist > max) throw ApiError.validation([{ in: 'body', path: 'gps', message: `You are ${dist} m from the listing pin (max ${max} m)` }], 'TOO_FAR');
  }
  move(v, d.result, user._id, d.remarks);
  Object.assign(v, { checklist: d.checklist, photos: d.photoFileIds, result: d.result, remarks: d.remarks, decidedAt: new Date() });
  await v.save();

  const lister = await User.findById(v.listerId);
  const vars = { visitNo: v.visitNo, listingNo: p.listingNo, remarks: d.remarks || '' };
  if (d.result === 'verified') {
    const days = await settings.get('verification.siteValidDays');
    p.verification.site = { status: 'verified', visitId: v._id, verifiedAt: new Date(), expiresAt: new Date(Date.now() + days * 86400000) };
    await p.save();
    if (lister) await notifyUser({ user: lister, event: 'verification_visit.verified', vars, channels: ['in_app', 'email'] });
  } else if (d.result === 'not_verified') {
    p.verification.site = { status: 'not_verified', visitId: v._id };
    // The property does not exist or does not match: moderation review (listing paused).
    if ((d.checklist.existsAtPin === false || d.checklist.matchesDetails === false || d.checklist.matchesPhotos === false) && p.status === 'live') {
      require('../listings/service').setStatus(p, 'paused', user._id, 'admin_review: site verification failed');
      p.pause = { reason: 'admin_review', note: 'Site verification failed', pausedAt: new Date(), by: user._id };
      await notifyPermission('properties.approve', 'verification_visit.review', vars);
    }
    await p.save();
    if (lister) await notifyUser({ user: lister, event: 'verification_visit.not_verified', vars, channels: ['in_app', 'email'] });
  } else {
    await Property.updateOne({ _id: p._id, 'verification.site.visitId': v._id, 'verification.site.status': 'scheduled' }, { $set: { 'verification.site.status': 'none' } });
    if (d.result === 'lister_absent') await notifyPermission('verification.schedule', 'verification_visit.lister_absent', vars);
  }
  await audit(req, { action: `verification_visit.${d.result}`, entityType: 'VerificationVisit', entityId: v._id, after: { result: d.result, distanceM: v.arrivalGps && v.arrivalGps.distanceM } });
  return { status: v.status, distanceM: v.arrivalGps && v.arrivalGps.distanceM };
}

async function expireSiteBadges(now = new Date()) {
  const r = await Property.updateMany({ 'verification.site.status': 'verified', 'verification.site.expiresAt': { $lt: now } }, { $set: { 'verification.site.status': 'expired' } });
  return r.modifiedCount;
}

module.exports = { listerRequest, list, schedule, patch, cancel, own, outcome, expireSiteBadges, CHECKLIST };
