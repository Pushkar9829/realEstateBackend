// Buyer side of Module C: "My enquiries" tracker with simplified stages
// (RE-C-18), visit confirm / reschedule request / cancel, token links from SMS
// and email, and post-visit feedback (RE-C-21).
const crypto = require('crypto');
const { z } = require('zod');
const { Lead, SiteVisit, Offer, FollowUp } = require('./models');
const { Property } = require('../listings/models');
const { User } = require('../auth/models');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { notifyUser } = require('../notifications/service');
const common = require('./common');
const slots = require('./slots.service');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function propertyCard(id) {
  if (!id) return null;
  const p = await Property.findById(id).select('listingNo title slug location.locality location.city media.photos status').lean();
  if (!p) return null;
  const cover = (p.media && p.media.photos || []).find((x) => x.isCover) || (p.media && p.media.photos || [])[0];
  return { listingNo: p.listingNo, title: p.title, slug: p.status === 'live' ? p.slug : undefined, locality: p.location && p.location.locality, city: p.location && p.location.city, cover: cover && (cover.thumbUrl || cover.url), available: p.status === 'live' };
}

const ownFilter = (user) => ({ $or: [{ 'buyer.userId': user._id }, { 'buyer.phone': user.phone }] });

async function agentFirstName(id) {
  if (!id || !(await settings.get('public.showAgentFirstName'))) return undefined;
  const a = await User.findById(id).select('name').lean();
  return a && a.name.split(' ')[0];
}

async function myEnquiries(user) {
  const leads = await Lead.find({ ...ownFilter(user), mergedInto: null }).sort({ createdAt: -1 }).limit(100).lean();
  return Promise.all(leads.map(async (l) => ({
    id: l._id, leadNo: l.leadNo, createdAt: l.createdAt, status: common.SIMPLE_STAGE[l.stage],
    property: await propertyCard(l.propertyId), requirement: !l.propertyId && !l.projectId ? { city: l.requirement && l.requirement.city, purpose: l.requirement && l.requirement.purpose } : undefined,
    agent: await agentFirstName(l.assignedTo),
  })));
}

const OFFER_WORDS = { awaiting_lister: 'Sent to the owner', awaiting_buyer: 'Owner replied - our team will call you', accepted: 'Accepted', declined: 'Declined by the owner', withdrawn: 'Withdrawn', expired: 'Expired' };

async function myEnquiry(user, id) {
  const l = await Lead.findOne({ _id: id, ...ownFilter(user) }).lean();
  if (!l) throw ApiError.notFound('Enquiry not found');
  const [visits, offers] = await Promise.all([
    SiteVisit.find({ leadId: l._id }).sort({ scheduledAt: -1 }).lean(),
    Offer.find({ leadId: l._id }).sort({ createdAt: -1 }).lean(),
  ]);
  const journey = ['Received', 'In touch', 'Visit scheduled', 'Visited', 'Negotiating', 'Booked'];
  return {
    id: l._id, leadNo: l.leadNo, status: common.SIMPLE_STAGE[l.stage], journey, step: Math.max(0, journey.indexOf(common.SIMPLE_STAGE[l.stage])), closed: ['closed_won', 'closed_lost'].includes(l.stage),
    property: await propertyCard(l.propertyId), agent: await agentFirstName(l.assignedTo), createdAt: l.createdAt,
    visits: visits.map((v) => ({ id: v._id, visitNo: v.visitNo, status: v.status, scheduledAt: v.scheduledAt, meetingPoint: v.meetingPoint, buyerNote: v.buyerNote, pickup: v.pickup, canConfirm: v.status === 'scheduled', canCancel: ['requested', 'scheduled', 'confirmed'].includes(v.status), feedbackGiven: Boolean(v.feedback && v.feedback.submittedAt) })),
    // A lister counter is shown only after the agent relays it (acceptance C12).
    offers: offers.map((o) => {
      const visible = o.rounds.filter((r) => r.by === 'agent' || r.relayedToBuyerAt);
      const last = visible[visible.length - 1];
      return { offerNo: o.offerNo, status: o.status === 'awaiting_buyer' && !(o.rounds[o.rounds.length - 1] || {}).relayedToBuyerAt ? 'Sent to the owner' : OFFER_WORDS[o.status], lastAmount: last && last.amount, rounds: visible.length };
    }),
  };
}

async function ownVisit(user, id) {
  const v = await SiteVisit.findById(id);
  if (!v) throw ApiError.notFound('Visit not found');
  const lead = await Lead.findOne({ _id: v.leadId, ...ownFilter(user) });
  if (!lead) throw ApiError.notFound('Visit not found');
  return { v, lead };
}

async function confirm(v, lead, by) {
  if (v.status !== 'scheduled') throw ApiError.conflict(v.status === 'confirmed' ? 'Already confirmed' : `This visit is ${v.status}`, 'INVALID_TRANSITION');
  if (v.scheduledAt < new Date()) throw ApiError.conflict('This visit has passed', 'VISIT_PASSED');
  v.status = 'confirmed';
  v.confirmedAt = new Date();
  await v.save();
  common.entry(lead, 'visit', by, { visitNo: v.visitNo, status: 'confirmed', via: by ? 'buyer' : 'link' });
  await lead.save();
  await scheduleReminders(v);
  return { status: v.status };
}

async function cancel(v, lead, by, reason) {
  if (!['requested', 'scheduled', 'confirmed'].includes(v.status)) throw ApiError.conflict(`This visit is ${v.status}`, 'INVALID_TRANSITION');
  const cutoff = await settings.get('visit.buyerCancelCutoffMinutes');
  if (v.status !== 'requested' && v.scheduledAt.getTime() - Date.now() < cutoff * 60000) throw ApiError.conflict('Too close to the visit. Please call the hotline.', 'CANCEL_CUTOFF');
  v.status = 'cancelled';
  v.cancelReason = reason || 'Cancelled by buyer';
  await v.save();
  common.entry(lead, 'visit', by, { visitNo: v.visitNo, status: 'cancelled', reason: v.cancelReason });
  if (lead.stage === 'site_visit_scheduled') { lead.stage = 'qualified'; common.entry(lead, 'stage', null, { from: 'site_visit_scheduled', to: 'qualified', note: 'Visit cancelled by buyer' }); }
  await lead.save();
  if (v.agentId) { const a = await User.findById(v.agentId); if (a) await notifyUser({ user: a, event: 'sitevisit.cancelled', vars: { visitNo: v.visitNo, reason: v.cancelReason } }); }
  return { status: v.status };
}

async function rescheduleRequest(v, lead, by, note) {
  if (!['scheduled', 'confirmed', 'requested'].includes(v.status)) throw ApiError.conflict(`This visit is ${v.status}`, 'INVALID_TRANSITION');
  v.rescheduleRequest = { at: new Date(), note };
  await v.save();
  common.entry(lead, 'visit', by, { visitNo: v.visitNo, status: 'reschedule_requested', note });
  await lead.save();
  if (v.agentId) {
    const a = await User.findById(v.agentId);
    if (a) await notifyUser({ user: a, event: 'sitevisit.reschedule_requested', vars: { visitNo: v.visitNo, note: note || '' } });
    const { FollowUp: F } = require('./models');
    await F.create({ leadId: lead._id, agentId: v.agentId, type: 'call', dueAt: new Date(Date.now() + 2 * 3600000), note: `Buyer asked to reschedule ${v.visitNo}: ${note || ''}` });
  }
  return { requested: true };
}

const meConfirm = async (user, id) => { const { v, lead } = await ownVisit(user, id); return confirm(v, lead, user._id); };
const meCancel = async (user, id, body) => { const { v, lead } = await ownVisit(user, id); return cancel(v, lead, user._id, z.object({ reason: z.string().max(300).optional() }).parse(body || {}).reason); };
const meReschedule = async (user, id, body) => { const { v, lead } = await ownVisit(user, id); return rescheduleRequest(v, lead, user._id, z.object({ note: z.string().max(300).optional() }).parse(body || {}).note); };

// Token link from SMS / email: GET shows the visit; ?action=confirm|cancel|change applies it.
async function tokenRespond(token, query) {
  const v = await SiteVisit.findOne({ confirmTokenHash: sha(token) });
  if (!v) throw ApiError.notFound('This link is not valid', 'TOKEN_INVALID');
  const lead = await Lead.findById(v.leadId);
  const p = await propertyCard(v.propertyId);
  let result;
  if (query.action === 'confirm') result = await confirm(v, lead, null);
  else if (query.action === 'cancel') result = await cancel(v, lead, null, 'Cancelled from the link');
  else if (query.action === 'change') result = await rescheduleRequest(v, lead, null, query.note);
  return { visitNo: v.visitNo, status: v.status, scheduledAt: v.scheduledAt, meetingPoint: v.meetingPoint, buyerNote: v.buyerNote, passed: v.scheduledAt < new Date(), property: p && { title: p.title, locality: p.locality, city: p.city, listingNo: p.listingNo }, agent: await agentFirstName(v.agentId), result };
}

// ---------------------------------------------------------------- reminders (C4 step 3)

async function scheduleReminders(v) {
  const jobs = require('../../core/jobs');
  const at = v.scheduledAt.getTime();
  const plan = [['buyer24', at - 24 * 3600000], ['buyer2', at - 2 * 3600000], ['agent1', at - 3600000], ['lister24', at - 24 * 3600000]];
  for (const [kind, when] of plan) {
    if (when > Date.now()) await jobs.enqueue('sitevisit.reminder', { visitId: String(v._id), kind, scheduledAt: v.scheduledAt }, { delayMs: when - Date.now(), uniqueKey: `visit:${v._id}:${kind}:${at}` });
  }
}

// ---------------------------------------------------------------- feedback (RE-C-21)

async function feedbackVisit(token) {
  const v = await SiteVisit.findOne({ 'feedback.tokenHash': sha(token) });
  if (!v) throw ApiError.notFound('This link is not valid', 'TOKEN_INVALID');
  const days = await settings.get('visit.feedbackLinkDays');
  if (v.feedback.sentAt && Date.now() - v.feedback.sentAt.getTime() > days * 86400000) throw ApiError.conflict('This link has expired', 'LINK_EXPIRED');
  return v;
}

async function feedbackForm(token) {
  const v = await feedbackVisit(token);
  const p = await propertyCard(v.propertyId);
  return { visitNo: v.visitNo, visitedAt: v.scheduledAt, property: p && { title: p.title, locality: p.locality, city: p.city, cover: p.cover }, submitted: Boolean(v.feedback.submittedAt) };
}

async function submitFeedback(token, body) {
  const d = z.object({
    interest: z.number().int().min(1).max(5), likes: z.array(z.string().max(40)).max(10).default([]), dislikes: z.array(z.string().max(40)).max(10).default([]),
    comments: z.string().trim().max(1000).optional(), secondVisit: z.boolean().default(false), callBack: z.boolean().default(false),
  }).parse(body);
  const v = await feedbackVisit(token);
  if (v.feedback.submittedAt) throw ApiError.conflict('Thanks, we already have your feedback', 'ALREADY_SUBMITTED');
  Object.assign(v.feedback, d, { submittedAt: new Date() });
  v.markModified('feedback');
  await v.save();
  const lead = await Lead.findById(v.leadId);
  common.entry(lead, 'feedback', null, { visitNo: v.visitNo, interest: d.interest, callBack: d.callBack, secondVisit: d.secondVisit });
  await lead.save();
  if (d.callBack && lead.assignedTo) {
    await FollowUp.create({ leadId: lead._id, agentId: lead.assignedTo, type: 'call', dueAt: await common.slaDue(new Date(), null), note: `Buyer asked for a call back after ${v.visitNo}` });
  }
  if (lead.assignedTo) { const a = await User.findById(lead.assignedTo); if (a) await notifyUser({ user: a, event: 'sitevisit.feedback_received', vars: { visitNo: v.visitNo, interest: d.interest, callBack: d.callBack ? 'yes' : 'no' } }); }
  return { thanks: true };
}

// Public free / unavailable slots for a property (no reasons shown).
async function publicSlots(propertyId, query) {
  const p = await Property.findOne({ _id: propertyId, status: 'live' }).select('listerId').lean();
  if (!p) throw ApiError.notFound('Property not found');
  return slots.slots({ listerId: p.listerId, propertyId }, query, { forBuyer: true });
}

module.exports = { myEnquiries, myEnquiry, meConfirm, meCancel, meReschedule, tokenRespond, scheduleReminders, feedbackForm, submitFeedback, publicSlots, confirm, cancel, sha };
