// Lister side of Module C (RE-B-09, RE-C-16/19/20): masked lead rows ("Buyer N",
// never contacts), visits on own listings, shared updates with responses,
// availability and the offers inbox.
const { z } = require('zod');
const { Lead, SiteVisit, Offer, ListerUpdate } = require('./models');
const { Property } = require('../listings/models');
const { User } = require('../auth/models');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { notifyUser } = require('../notifications/service');
const guard = require('../masking/guard');
const common = require('./common');

async function ownPropertyIds(user) {
  return Property.find({ listerId: user._id }).distinct('_id');
}

// ?propertyId= narrowed to the lister's own listings (an unknown id matches nothing).
async function scopedPropertyIds(user, query) {
  const ids = await ownPropertyIds(user);
  if (!query || !query.propertyId) return ids;
  return ids.filter((i) => String(i) === String(query.propertyId));
}

// Funnel buckets in stage order. Stages sharing a simplified label (the buyer
// tracker labels, spec RE-S-LIS-13: contacted + qualified = "In touch",
// booking + closed_won = "Booked") are merged here, before small-count masking.
function funnelOf(rows) {
  const buckets = [];
  common.OPEN_STAGES.concat(['closed_won', 'closed_lost']).forEach((s) => {
    const label = common.SIMPLE_STAGE[s];
    let b = buckets.find((x) => x.label === label);
    if (!b) { b = { stage: s, stages: [], label, count: 0 }; buckets.push(b); }
    b.stages.push(s);
    b.count += rows.filter((r) => r.stage === s).length;
  });
  return buckets.map((b) => ({ ...b, count: b.count > 0 && b.count < 3 ? '<3' : b.count }));
}

async function titles(ids) {
  const rows = await Property.find({ _id: { $in: ids } }).select('listingNo title').lean();
  return Object.fromEntries(rows.map((p) => [String(p._id), { listingNo: p.listingNo, title: p.title }]));
}

// Lead rows without any buyer identity; counts under 3 are not broken down further.
async function leads(user, query) {
  const ids = await scopedPropertyIds(user, query);
  const filter = { propertyId: { $in: ids }, mergedInto: null };
  const rows = await Lead.find(filter).sort({ createdAt: -1 }).limit(200).select('buyerLabel stage propertyId createdAt lastActivityAt').lean();
  const t = await titles(rows.map((r) => r.propertyId));
  const visitCounts = await SiteVisit.aggregate([{ $match: { leadId: { $in: rows.map((r) => r._id) } } }, { $group: { _id: '$leadId', n: { $sum: 1 }, done: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } }]);
  const vc = Object.fromEntries(visitCounts.map((v) => [String(v._id), v]));
  return {
    items: rows.map((r) => ({ id: r._id, buyer: r.buyerLabel || 'A buyer', status: common.SIMPLE_STAGE[r.stage], property: t[String(r.propertyId)], createdAt: r.createdAt, lastActivityAt: r.lastActivityAt, visits: (vc[String(r._id)] || {}).n || 0, visitsDone: (vc[String(r._id)] || {}).done || 0 })),
    funnel: funnelOf(rows),
  };
}

async function visits(user, query) {
  const ids = await scopedPropertyIds(user, query);
  const filter = { propertyId: { $in: ids } };
  const range = common.dateRange(query);
  if (query.upcoming === 'true') { filter.scheduledAt = { $gte: new Date() }; filter.status = { $in: ['scheduled', 'confirmed'] }; }
  if (range) {
    const floor = filter.scheduledAt && filter.scheduledAt.$gte; // "upcoming" never reaches into the past
    filter.scheduledAt = { ...range, ...(floor && (!range.$gte || range.$gte < floor) ? { $gte: floor } : {}) };
  }
  const rows = await SiteVisit.find(filter).sort({ scheduledAt: -1 }).limit(200).populate('leadId', 'buyerLabel').lean();
  const t = await titles(rows.map((r) => r.propertyId));
  // Average buyer feedback per listing once at least 3 exist (C7 step 3).
  const fb = await SiteVisit.aggregate([{ $match: { propertyId: { $in: ids }, 'feedback.submittedAt': { $ne: null } } }, { $group: { _id: '$propertyId', n: { $sum: 1 }, avg: { $avg: '$feedback.interest' } } }]);
  return {
    items: rows.map((v) => ({
      id: v._id, visitNo: v.visitNo, buyer: (v.leadId && v.leadId.buyerLabel) || 'A buyer', property: t[String(v.propertyId)], scheduledAt: v.scheduledAt, status: v.status,
      outsideListerSlots: v.outsideListerSlots, overrideReason: v.overrideReason,
      lastReschedule: (v.history || []).length ? { at: v.history[v.history.length - 1].at, reason: v.history[v.history.length - 1].reason } : undefined,
      outcome: v.sharedWithLister && v.outcome ? { result: v.outcome.result, interest: v.outcome.interest, nextStep: v.outcome.nextStep } : undefined,
    })),
    feedback: fb.filter((f) => f.n >= 3).map((f) => ({ property: t[String(f._id)], averageInterest: Math.round(f.avg * 10) / 10, responses: f.n })),
  };
}

async function activity(user, query = {}) {
  const ids = await scopedPropertyIds(user, query);
  const filter = { propertyId: { $in: ids } };
  const range = common.dateRange(query);
  if (range) filter.createdAt = range;
  const rows = await ListerUpdate.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const t = await titles(rows.map((r) => r.propertyId));
  return rows.map((u) => ({ id: u._id, property: t[String(u.propertyId)], buyer: u.buyerLabel, text: u.text, tag: u.tag, amount: u.amount, response: u.response, respondedAt: u.respondedAt, createdAt: u.createdAt }));
}

async function respond(user, id, body, req) {
  const { response } = z.object({ response: z.string().trim().min(2).max(1000) }).parse(body);
  const u = await ListerUpdate.findById(id);
  if (!u) throw ApiError.notFound('Update not found');
  if (!(await Property.exists({ _id: u.propertyId, listerId: user._id }))) throw ApiError.notFound('Update not found');
  await guard.assertNoContactInfo({ response }, req);
  u.response = response; u.respondedAt = new Date();
  await u.save();
  const lead = u.leadId && await Lead.findById(u.leadId);
  if (lead) {
    common.entry(lead, 'lister_response', null, { text: response });
    await lead.save();
    if (lead.assignedTo) { const a = await User.findById(lead.assignedTo); if (a) await notifyUser({ user: a, event: 'lister.responded', vars: { leadNo: lead.leadNo, leadId: String(lead._id) } }); }
  }
  return u;
}

// ---------------------------------------------------------------- offers inbox (C6)

function offerView(o, t) {
  return {
    id: o._id, offerNo: o.offerNo, buyer: o.buyerLabel, status: o.status, validUntil: o.validUntil, property: t && t[String(o.propertyId)],
    rounds: o.rounds.map((r) => ({ n: r.n, by: r.by === 'agent' ? 'Buyer (via our agent)' : 'You', kind: r.kind, amount: r.amount, terms: r.terms, note: r.note, at: r.at })),
    canRespond: o.status === 'awaiting_lister',
  };
}

async function offers(user, query) {
  const filter = { listerId: user._id };
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  const rows = await Offer.find(filter).sort({ updatedAt: -1 }).limit(100).lean();
  const t = await titles(rows.map((r) => r.propertyId));
  return rows.map((o) => offerView(o, t));
}

async function offer(user, id) {
  const o = await Offer.findOne({ _id: id, listerId: user._id }).lean();
  if (!o) throw ApiError.notFound('Offer not found');
  const t = await titles([o.propertyId]);
  const others = await Offer.countDocuments({ propertyId: o.propertyId, _id: { $ne: o._id }, status: { $in: ['awaiting_lister', 'awaiting_buyer', 'accepted'] } });
  return { ...offerView(o, t), otherOpenOffers: others };
}

async function respondOffer(user, id, body) {
  const d = z.object({ action: z.enum(['accept', 'counter', 'decline']), amount: z.number().positive().optional(), note: z.string().trim().max(500).optional(), reason: z.string().trim().max(300).optional(), terms: z.object({ token: z.number().positive().optional(), possessionDate: z.coerce.date().optional(), inclusions: z.string().trim().max(300).optional() }).optional() }).parse(body);
  const o = await Offer.findOne({ _id: id, listerId: user._id });
  if (!o) throw ApiError.notFound('Offer not found');
  if (o.status !== 'awaiting_lister') throw ApiError.conflict('This offer is not waiting for your answer', 'INVALID_TRANSITION');
  if (o.validUntil && o.validUntil < new Date()) throw ApiError.conflict('This offer has expired', 'OFFER_EXPIRED');
  if (d.action === 'counter' && !d.amount) throw ApiError.validation([{ in: 'body', path: 'amount', message: 'Enter your counter amount' }]);
  if (d.action === 'decline' && !d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'Give a short reason' }]);
  if (o.rounds.length >= await settings.get('offer.maxRounds')) throw ApiError.conflict('Maximum rounds reached', 'ROUND_LIMIT');
  const last = o.rounds[o.rounds.length - 1];
  o.rounds.push({ n: o.rounds.length + 1, by: 'lister', kind: d.action, amount: d.action === 'counter' ? Math.round(d.amount * 100) : last.amount, note: d.note || d.reason,
    terms: d.terms ? { token: d.terms.token ? Math.round(d.terms.token * 100) : undefined, possessionDate: d.terms.possessionDate, inclusions: d.terms.inclusions } : undefined });
  o.status = { accept: 'accepted', counter: 'awaiting_buyer', decline: 'declined' }[d.action];
  await o.save();
  const lead = await Lead.findById(o.leadId);
  if (lead) { common.entry(lead, 'offer', null, { offerNo: o.offerNo, round: o.rounds.length, by: 'lister', kind: d.action, amount: o.rounds[o.rounds.length - 1].amount }); await lead.save(); }
  const agent = await User.findById(o.agentId);
  if (agent) await notifyUser({ user: agent, event: 'offer.responded', channels: ['in_app', 'sms'], vars: { offerNo: o.offerNo, action: { accept: 'accepted', counter: 'countered', decline: 'declined' }[d.action] } });
  return offerView(o.toObject(), await titles([o.propertyId]));
}

module.exports = { leads, visits, activity, respond, offers, offer, respondOffer };
