// RE-C-19 lister visit availability (workflow C5): weekly ranges and blackout
// dates at account, project or property scope (most specific wins). Slots are
// 30 minutes inside visit.dayStart-dayEnd (IST), at least max(minLeadHours,
// lister notice) ahead and within the booking horizon.
const { z } = require('zod');
const { VisitAvailability, SiteVisit } = require('./models');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');

const IST = 330 * 60000;
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

async function availabilityFor(listerId, { propertyId, projectId } = {}) {
  const docs = await VisitAvailability.find({ listerId }).lean();
  return docs.find((d) => d.scope === 'property' && propertyId && String(d.scopeId) === String(propertyId))
    || docs.find((d) => d.scope === 'project' && projectId && String(d.scopeId) === String(projectId))
    || docs.find((d) => d.scope === 'account') || null;
}

// Is a slot start (Date) bookable? Returns { ok, reason }.
async function checkSlot(at, { listerId, propertyId, projectId }, { ignoreNotice = false } = {}) {
  const s = await settings.all();
  const av = listerId ? await availabilityFor(listerId, { propertyId, projectId }) : null;
  const local = new Date(at.getTime() + IST);
  const min = local.getUTCHours() * 60 + local.getUTCMinutes();
  const slot = s['visit.slotMinutes'];
  if (min % slot !== 0) return { ok: false, reason: `Slots start every ${slot} minutes` };
  if (min < toMin(s['visit.dayStart']) || min + slot > toMin(s['visit.dayEnd'])) return { ok: false, reason: `Visits run ${s['visit.dayStart']}-${s['visit.dayEnd']}` };
  const notice = Math.max(s['visit.minLeadHours'], (av && av.noticeHours) || 0);
  if (!ignoreNotice && at.getTime() < Date.now() + notice * 3600000) return { ok: false, reason: `Book at least ${notice} hours ahead` };
  if (at.getTime() > Date.now() + s['visit.horizonDays'] * 86400000) return { ok: false, reason: `Book within ${s['visit.horizonDays']} days` };
  if (!av || !s['visit.listerSlotsEnforced']) return { ok: true };
  if ((av.blackouts || []).some((b) => at >= new Date(b.from) && at < new Date(b.to))) return { ok: false, reason: 'The owner is not available on this date' };
  if (!(av.weekly || []).length) return { ok: true };
  const day = local.getUTCDay();
  const inside = av.weekly.some((w) => w.day === day && min >= toMin(w.start) && min + slot <= toMin(w.end));
  return inside ? { ok: true } : { ok: false, reason: 'Outside the owner\'s visit slots' };
}

// Free / unavailable 30-minute slots per day for a date range (max 14 days).
async function slots({ listerId, propertyId, projectId }, query, { forBuyer = false } = {}) {
  const s = await settings.all();
  const from = query.from ? new Date(query.from) : new Date();
  const days = Math.min(14, Math.max(1, parseInt(query.days, 10) || 7));
  const startDay = new Date(Date.UTC(new Date(from.getTime() + IST).getUTCFullYear(), new Date(from.getTime() + IST).getUTCMonth(), new Date(from.getTime() + IST).getUTCDate()));
  const booked = propertyId ? await SiteVisit.find({ propertyId, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $gte: startDay, $lt: new Date(startDay.getTime() + (days + 1) * 86400000) } }).select('scheduledAt').lean() : [];
  const takenSet = new Set(booked.map((b) => new Date(b.scheduledAt).getTime()));
  const out = [];
  for (let d = 0; d < days; d += 1) {
    const dayStartUtc = new Date(startDay.getTime() + d * 86400000 - IST); // 00:00 IST
    const list = [];
    for (let m = toMin(s['visit.dayStart']); m + s['visit.slotMinutes'] <= toMin(s['visit.dayEnd']); m += s['visit.slotMinutes']) {
      const at = new Date(dayStartUtc.getTime() + m * 60000);
      const c = await checkSlot(at, { listerId, propertyId, projectId });
      const free = c.ok && !takenSet.has(at.getTime());
      list.push(forBuyer ? { at, free } : { at, free, reason: c.ok ? (free ? undefined : 'Another visit is booked') : c.reason });
    }
    out.push({ date: new Date(dayStartUtc.getTime() + IST).toISOString().slice(0, 10), slots: list });
  }
  return out;
}

// ---------------------------------------------------------------- lister management (RE-S-LIS-17)

const scopeSchema = z.object({ scope: z.enum(['account', 'project', 'property']).default('account'), scopeId: z.string().regex(/^[a-f0-9]{24}$/).optional() });

async function getOwn(user, query) {
  const { scope, scopeId } = scopeSchema.parse(query);
  let doc = await VisitAvailability.findOne({ listerId: user._id, scope, scopeId: scopeId || null }).lean();
  if (doc && (doc.blackouts || []).some((b) => !b._id)) { // blackouts saved before they had ids: give them one
    const mongoose = require('mongoose');
    const blackouts = doc.blackouts.map((b) => (b._id ? b : { ...b, _id: new mongoose.Types.ObjectId() }));
    await VisitAvailability.updateOne({ _id: doc._id }, { $set: { blackouts } });
    doc = { ...doc, blackouts };
  }
  const all = await VisitAvailability.find({ listerId: user._id }).select('scope scopeId').lean();
  return { availability: doc || { scope, scopeId, weekly: [], blackouts: [], noticeHours: 2 }, scopes: all };
}

async function assertOwnScope(user, scope, scopeId) {
  if (scope === 'account') return;
  if (!scopeId) throw ApiError.validation([{ in: 'body', path: 'scopeId', message: 'Choose the listing or project' }]);
  const Model = scope === 'property' ? require('../listings/models').Property : require('../projects/models').Project;
  const owner = scope === 'property' ? 'listerId' : 'builderId';
  if (!(await Model.exists({ _id: scopeId, [owner]: user._id }))) throw ApiError.notFound('Listing or project not found');
}

async function saveWeekly(user, body, req) {
  const d = scopeSchema.extend({
    weekly: z.array(z.object({ day: z.number().int().min(0).max(6), start: HHMM, end: HHMM })).max(20),
    noticeHours: z.number().int().min(2).max(48).default(2),
    note: z.string().trim().max(300).optional(),
  }).parse(body);
  await assertOwnScope(user, d.scope, d.scopeId);
  const s = await settings.all();
  for (const w of d.weekly) {
    if (toMin(w.start) >= toMin(w.end)) throw ApiError.validation([{ in: 'body', path: 'weekly', message: 'Each range must end after it starts' }]);
    if (toMin(w.start) < toMin(s['visit.dayStart']) || toMin(w.end) > toMin(s['visit.dayEnd'])) throw ApiError.validation([{ in: 'body', path: 'weekly', message: `Ranges must be within ${s['visit.dayStart']}-${s['visit.dayEnd']}` }]);
    if (toMin(w.start) % 30 || toMin(w.end) % 30) throw ApiError.validation([{ in: 'body', path: 'weekly', message: 'Use 30-minute steps (e.g. 09:00, 09:30)' }]);
  }
  const doc = await VisitAvailability.findOneAndUpdate({ listerId: user._id, scope: d.scope, scopeId: d.scopeId || null },
    { $set: { weekly: d.weekly, noticeHours: d.noticeHours, note: d.note } }, { upsert: true, new: true });
  await flagConflicts(user, doc);
  await audit(req, { action: 'availability.save', entityType: 'VisitAvailability', entityId: doc._id });
  return doc;
}

async function addBlackout(user, body, req) {
  const d = scopeSchema.extend({ from: z.coerce.date(), to: z.coerce.date(), reason: z.string().trim().max(120).optional() }).parse(body);
  await assertOwnScope(user, d.scope, d.scopeId);
  const s = await settings.all();
  if (d.to <= d.from) throw ApiError.validation([{ in: 'body', path: 'to', message: 'The end must be after the start' }]);
  if (d.to > new Date(Date.now() + s['visit.blackoutMaxDays'] * 86400000)) throw ApiError.validation([{ in: 'body', path: 'to', message: `Blackouts up to ${s['visit.blackoutMaxDays']} days ahead` }]);
  const doc = await VisitAvailability.findOneAndUpdate({ listerId: user._id, scope: d.scope, scopeId: d.scopeId || null }, { $push: { blackouts: { from: d.from, to: d.to, reason: d.reason } } }, { upsert: true, new: true });
  await flagConflicts(user, doc);
  await audit(req, { action: 'availability.blackout', entityType: 'VisitAvailability', entityId: doc._id });
  return doc;
}

// By blackout _id (any scope of this lister), or by the old numeric index
// within ?scope / ?scopeId (kept for older clients).
async function removeBlackout(user, ref, query, req) {
  const key = String(ref);
  if (/^[a-f0-9]{24}$/.test(key)) {
    const doc = await VisitAvailability.findOne({ listerId: user._id, 'blackouts._id': key });
    if (!doc) throw ApiError.notFound('Blackout not found');
    doc.blackouts.pull({ _id: key });
    await doc.save();
    if (req) await audit(req, { action: 'availability.blackout_removed', entityType: 'VisitAvailability', entityId: doc._id });
    return doc;
  }
  if (!/^\d+$/.test(key)) throw ApiError.notFound('Blackout not found');
  const { scope, scopeId } = scopeSchema.parse(query);
  const doc = await VisitAvailability.findOne({ listerId: user._id, scope, scopeId: scopeId || null });
  const i = Number(key);
  if (!doc || !doc.blackouts[i]) throw ApiError.notFound('Blackout not found');
  doc.blackouts.splice(i, 1);
  await doc.save();
  if (req) await audit(req, { action: 'availability.blackout_removed', entityType: 'VisitAvailability', entityId: doc._id });
  return doc;
}

// Visits already booked are not changed; their agents are asked to re-confirm (C5 step 5).
async function flagConflicts(user, doc) {
  const { Property } = require('../listings/models');
  const props = doc.scope === 'property' ? [doc.scopeId] : await Property.find({ listerId: user._id }).distinct('_id');
  const visits = await SiteVisit.find({ propertyId: { $in: props }, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $gt: new Date() } });
  const { User } = require('../auth/models');
  const { notifyUser } = require('../notifications/service');
  for (const v of visits) {
    const c = await checkSlot(v.scheduledAt, { listerId: user._id, propertyId: v.propertyId }, { ignoreNotice: true });
    if (!c.ok && v.agentId) {
      const agent = await User.findById(v.agentId);
      if (agent) await notifyUser({ user: agent, event: 'availability.conflict', channels: ['in_app', 'email'], vars: { visitNo: v.visitNo, reason: c.reason } });
    }
  }
}

module.exports = { availabilityFor, checkSlot, slots, getOwn, saveWeekly, addBlackout, removeBlackout };
