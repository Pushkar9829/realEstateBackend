// Agent panel of Module C (RE-C-02/08..16, 19, 20): Today, my leads and board,
// stage changes, call logs, notes, follow-ups, site visits, sales sheet,
// suggested matches and offers. Agents see only leads assigned to them;
// managers also see leads of the teams they manage.
const crypto = require('crypto');
const { z } = require('zod');
const { Lead, FollowUp, SiteVisit, Offer, ListerUpdate, BuyerContact } = require('./models');
const { Property } = require('../listings/models');
const { User } = require('../auth/models');
const authV = require('../auth/validators');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const env = require('../../config/env');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser, notifyLeadBuyer, sendNow, whatsappOptedIn } = require('../notifications/service');
const guard = require('../masking/guard');
const reveal = require('../masking/reveal.service');
const common = require('./common');
const slots = require('./slots.service');
const buyerSvc = require('./buyer.service');
const { sendWhatsapp } = require('./whatsapp.send');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const maskPhone = (p) => (p ? `${p.slice(0, 3)} ••••• ${p.slice(-3)}` : '');
const dayBounds = (d = new Date()) => { const ist = new Date(d.getTime() + 330 * 60000); const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000); return { start, end: new Date(start.getTime() + 86400000) }; };

// ---------------------------------------------------------------- scope

async function scopeFilter(user) {
  if (user.role === 'manager') {
    const teams = await reveal.managedTeamIds(user);
    return { $or: [{ assignedTo: user._id }, { teamId: { $in: teams } }] };
  }
  return { assignedTo: user._id };
}

async function scopedLead(user, id) {
  const lead = await common.leadOr404(id);
  if (!(await reveal.leadInScope(user, lead))) throw ApiError.forbidden('This lead is not assigned to you', 'OUT_OF_SCOPE');
  return lead;
}

function leadRow(l) {
  return {
    _id: l._id, leadNo: l.leadNo, stage: l.stage, priority: l.priority, sources: l.sources, buyerName: l.buyer && l.buyer.name, buyerPhone: maskPhone(l.buyer && l.buyer.phone),
    propertyId: l.propertyId, projectId: l.projectId, requirement: l.requirement, assignedTo: l.assignedTo, slaDueAt: l.slaDueAt, slaBreachedAt: l.slaBreachedAt, firstContactAt: l.firstContactAt,
    lastActivityAt: l.lastActivityAt, createdAt: l.createdAt, throttled: l.throttled, buyerLabel: l.buyerLabel,
  };
}

async function attachProperties(rows) {
  const ids = [...new Set(rows.map((r) => r.propertyId).filter(Boolean).map(String))];
  const props = await Property.find({ _id: { $in: ids } }).select('listingNo title location.locality location.city status price purpose').lean();
  const byId = Object.fromEntries(props.map((p) => [String(p._id), { listingNo: p.listingNo, title: p.title, locality: p.location && p.location.locality, city: p.location && p.location.city, status: p.status, purpose: p.purpose, price: p.purpose === 'rent' ? p.price && p.price.monthlyRent : p.price && p.price.amount }]));
  return rows.map((r) => ({ ...r, property: r.propertyId ? byId[String(r.propertyId)] : undefined }));
}

// ---------------------------------------------------------------- Today (RE-S-AGT-01)

async function dashboard(user) {
  const now = new Date();
  const { start, end } = dayBounds(now);
  const mine = await scopeFilter(user);
  const outcomeDue = new Date(now.getTime() - 30 * 60000);
  const [slaDue, overdue, todayFu, visits, outcomePending, offersToRelay, newLeads, open, callBacks] = await Promise.all([
    Lead.find({ ...mine, stage: 'new', firstContactAt: null }).sort({ slaDueAt: 1 }).limit(20).lean(),
    FollowUp.find({ agentId: user._id, status: 'open', dueAt: { $lt: start } }).sort({ dueAt: 1 }).limit(50).populate('leadId', 'leadNo buyer.name stage').lean(),
    FollowUp.find({ agentId: user._id, status: 'open', dueAt: { $gte: start, $lt: end } }).sort({ dueAt: 1 }).populate('leadId', 'leadNo buyer.name stage').lean(),
    SiteVisit.find({ agentId: user._id, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $gte: start, $lt: end } }).sort({ scheduledAt: 1 }).populate('propertyId', 'listingNo title location.locality location.addressLine').populate('leadId', 'leadNo buyer.name').lean(),
    SiteVisit.find({ agentId: user._id, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $lt: outcomeDue } }).sort({ scheduledAt: 1 }).limit(20).populate('leadId', 'leadNo buyer.name').lean(),
    Offer.find({ agentId: user._id, status: 'awaiting_buyer' }).populate('leadId', 'leadNo buyer.name').lean(),
    Lead.countDocuments({ assignedTo: user._id, createdAt: { $gte: start } }),
    Lead.countDocuments({ assignedTo: user._id, stage: { $in: common.OPEN_STAGES } }),
    SiteVisit.find({ agentId: user._id, 'feedback.callBack': true, 'feedback.submittedAt': { $gte: new Date(now.getTime() - 7 * 86400000) } }).populate('leadId', 'leadNo buyer.name').lean(),
  ]);
  let returnedDeals = [];
  try { const { Deal } = require('../deals/models'); returnedDeals = await Deal.find({ agentId: user._id, status: 'returned' }).select('dealNo leadId review.comment updatedAt').lean(); returnedDeals = returnedDeals.map((d) => ({ _id: d._id, dealNo: d.dealNo, leadId: d.leadId, updatedAt: d.updatedAt, returnNote: d.review && d.review.comment })); } catch { /* deals module optional */ }
  const team = await require('../teams/service').myTeam(user);
  return {
    counts: { open, newToday: newLeads, slaDue: slaDue.length, overdue: overdue.length, followUpsToday: todayFu.length, visitsToday: visits.length, outcomePending: outcomePending.length, offersToRelay: offersToRelay.filter((o) => { const last = o.rounds[o.rounds.length - 1]; return last && last.by === 'lister' && !last.relayedToBuyerAt; }).length },
    slaDue: (await attachProperties(slaDue.map(leadRow))).map((l) => ({ ...l, breached: Boolean(l.slaBreachedAt) || (l.slaDueAt && new Date(l.slaDueAt) < now) })),
    overdue, followUpsToday: todayFu, visitsToday: visits, outcomePending,
    offersToRelay: offersToRelay.map((o) => ({ _id: o._id, offerNo: o.offerNo, lead: o.leadId, lastRound: o.rounds[o.rounds.length - 1] })),
    callBacks: callBacks.map((v) => ({ visitNo: v.visitNo, lead: v.leadId, interest: v.feedback.interest })),
    returnedDeals, availability: team,
  };
}

// ---------------------------------------------------------------- my leads and board

async function list(user, query) {
  const filter = { ...(await scopeFilter(user)), mergedInto: null };
  if (query.stage) filter.stage = { $in: String(query.stage).split(',') };
  else if (query.open !== 'false') filter.stage = { $in: common.OPEN_STAGES };
  if (query.priority) filter.priority = query.priority;
  if (query.breached === 'true') filter.slaBreachedAt = { $ne: null };
  if (query.source) filter.sources = { $in: String(query.source).split(',') };
  if (query.city) filter['requirement.city'] = new RegExp(`^${escRx(String(query.city).trim())}$`, 'i');
  if (query.purpose) filter['requirement.purpose'] = String(query.purpose);
  const range = common.dateRange(query);
  if (range) filter.createdAt = range;
  if (query.q) {
    const rx = new RegExp(escRx(query.q), 'i');
    filter.$and = [{ $or: [{ leadNo: rx }, { 'buyer.name': rx }, { 'buyer.phone': rx }] }];
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, parseInt(query.limit, 10) || 25);
  const sort = { recent: { lastActivityAt: -1 }, sla: { slaDueAt: 1 }, newest: { createdAt: -1 } }[query.sort] || { lastActivityAt: -1 };
  const [items, total] = await Promise.all([Lead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(), Lead.countDocuments(filter)]);
  return { items: await attachProperties(items.map(leadRow)), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function board(user) {
  const items = await Lead.find({ ...(await scopeFilter(user)), stage: { $in: common.OPEN_STAGES }, mergedInto: null }).sort({ lastActivityAt: -1 }).limit(500).lean();
  const rows = await attachProperties(items.map(leadRow));
  return Object.fromEntries(common.OPEN_STAGES.map((s) => [s, rows.filter((r) => r.stage === s)]));
}

// ---------------------------------------------------------------- manual capture (RE-C-02)

async function manualLead(user, body, req) {
  const d = z.object({
    source: z.enum(['hotline', 'walk_in', 'whatsapp', 'referral']), name: z.string().trim().min(2).max(80), phone: authV.phone, email: authV.email.optional(),
    propertyId: oid.optional(), referralCode: z.string().trim().toUpperCase().max(20).optional(), notes: z.string().trim().max(1000).optional(),
    requirement: z.object({ purpose: z.enum(['sale', 'rent']).optional(), city: z.string().max(60).optional(), localities: z.array(z.string()).max(10).optional(), bhk: z.array(z.number().int()).max(6).optional(), budgetMin: z.number().optional(), budgetMax: z.number().optional() }).optional(),
    consent: z.literal(true, { errorMap: () => ({ message: 'Confirm the buyer agreed to be contacted' }) }),
  }).parse(body);
  const s = await settings.all();
  if (d.propertyId) {
    const dup = await Lead.findOne({ 'buyer.phone': d.phone, propertyId: d.propertyId, stage: { $in: common.OPEN_STAGES }, createdAt: { $gte: new Date(Date.now() - s['lead.dedupeDays'] * 86400000) } }).select('leadNo assignedTo').lean();
    if (dup) throw new ApiError(409, 'DUPLICATE_LEAD', `This buyer already has lead ${dup.leadNo} on this property`, { leadId: dup._id, leadNo: dup.leadNo });
  }
  const contact = await BuyerContact.findOneAndUpdate({ phone: d.phone }, { $set: { name: d.name, ...(d.email ? { email: d.email } : {}) }, $setOnInsert: { phone: d.phone, referralCode: d.referralCode } }, { upsert: true, new: true });
  const p = d.propertyId ? await Property.findById(d.propertyId).lean() : null;
  const lead = new Lead({
    leadNo: await counters.leadNo(), buyer: { contactId: contact._id, userId: contact.userId, name: d.name, phone: d.phone, email: d.email },
    propertyId: d.propertyId, sources: [d.source], requirement: { ...(d.requirement || {}), notes: d.notes, ...(p ? { purpose: p.purpose, city: p.location.city } : {}) },
    buyerLabel: await common.nextBuyerLabel(d.propertyId), referralCode: d.referralCode || contact.referralCode, consentAt: new Date(),
  });
  common.entry(lead, 'created', user._id, { type: d.source, manual: true });
  const { Team } = require('../teams/models');
  const team = await Team.findOne({ 'members.agentId': user._id });
  await common.assign(lead, user._id, user._id, { team, note: 'Logged by agent' });
  await lead.save();
  if (p) await Property.updateOne({ _id: p._id }, { $inc: { 'stats.enquiries': 1 } });
  await audit(req, { action: 'lead.manual', entityType: 'Lead', entityId: lead._id });
  return leadRow(lead.toObject());
}

// ---------------------------------------------------------------- detail and updates

async function detail(user, id) {
  const lead = await scopedLead(user, id);
  const l = lead.toObject();
  const [visits, followups, offers, linked] = await Promise.all([
    SiteVisit.find({ leadId: l._id }).sort({ scheduledAt: -1 }).lean(),
    FollowUp.find({ leadId: l._id }).sort({ dueAt: -1 }).limit(50).lean(),
    Offer.find({ leadId: l._id }).sort({ createdAt: -1 }).lean(),
    Property.find({ _id: { $in: [l.propertyId, ...(l.linkedProperties || [])].filter(Boolean) } }).select('listingNo title status location.locality location.city price purpose details.bhk').lean(),
  ]);
  const by = [...new Set([...l.timeline.map((t) => t.by), l.assignedTo].filter(Boolean).map(String))];
  const names = Object.fromEntries((await User.find({ _id: { $in: by } }).select('name').lean()).map((u) => [String(u._id), u.name]));
  const { Team } = require('../teams/models');
  const [deal, team, seekerFlag, nextFollowUp, photoUrls, waEnabled] = await Promise.all([
    linkedDeal(l._id), l.teamId ? Team.findById(l.teamId).select('name').lean() : null, seekerStatus(l),
    FollowUp.findOne({ leadId: l._id, status: 'open' }).sort({ dueAt: 1 }).select('type dueAt note').lean(),
    visitPhotoUrls(visits), settings.get('whatsapp.enabled'),
  ]);
  const waOptIn = waEnabled ? await buyerWhatsappOptIn(l) : false;
  return {
    ...leadRow(l), buyer: { name: l.buyer.name, phone: maskPhone(l.buyer.phone), hasEmail: Boolean(l.buyer.email) }, referralCode: l.referralCode,
    lostReason: l.lostReason, lostNote: l.lostNote, linkedProperties: l.linkedProperties, callAttempts: l.callAttempts, whatsappOptIn: l.whatsappOptIn, utm: l.utm,
    enquiry: l.enquiry || {},
    timeline: l.timeline.slice().reverse().map((t) => ({ ...t, byName: t.by ? names[String(t.by)] : 'System' })),
    visits: visits.map((v) => (v.outcome && (v.outcome.photos || []).length ? { ...v, outcome: { ...v.outcome, photoUrls: v.outcome.photos.map((id) => photoUrls[String(id)]).filter(Boolean) } } : v)),
    followups, offers, properties: linked, reassignRequests: l.reassignRequests,
    deal, agent: l.assignedTo ? { _id: l.assignedTo, name: names[String(l.assignedTo)] } : null, team: team ? { _id: team._id, name: team.name } : null,
    seekerFlag, nextFollowUp,
    whatsapp: whatsappState(waEnabled, waOptIn),
  };
}

// Latest deal on the lead (read-only view of the deals module).
async function linkedDeal(leadId) {
  try {
    const { Deal } = require('../deals/models');
    const d = await Deal.findOne({ leadId }).sort({ createdAt: -1 }).select('dealNo status').lean();
    return d ? { _id: d._id, dealNo: d.dealNo, status: d.status } : null;
  } catch { return null; } // deals module optional
}

// Seeker flag on the buyer's phone (RE-F-10): the lead's own flag, else an open / actioned one.
async function seekerStatus(l) {
  const { SeekerFlag } = require('../kyc/models');
  const seeker = require('../kyc/seeker.service');
  let f = l.seekerFlagId ? await SeekerFlag.findById(l.seekerFlagId).select('flagNo status action rule until').lean() : null;
  if (!f && l.buyer && l.buyer.phone) f = await SeekerFlag.findOne({ phoneHash: seeker.phoneHash(l.buyer.phone), status: { $in: ['open', 'actioned'] } }).sort({ createdAt: -1 }).select('flagNo status action rule until').lean();
  if (!f) return l.throttled ? { flagged: false, throttled: true } : null;
  return { flagged: true, flagNo: f.flagNo, status: f.status, action: f.action, rule: f.rule, until: f.until, throttled: Boolean(l.throttled) };
}

// Short-lived signed URLs for visit outcome photos: { fileId: { id, url, thumbUrl } }.
async function visitPhotoUrls(visits) {
  const ids = visits.flatMap((v) => (v.outcome && v.outcome.photos) || []);
  if (!ids.length) return {};
  const storage = require('../../core/storage');
  const files = await storage.FileModel.find({ _id: { $in: ids } }).lean();
  return Object.fromEntries(files.map((f) => [String(f._id), {
    id: f._id, url: storage.urlFor(f, 600), thumbUrl: f.meta && f.meta.thumbKey ? storage.urlFor({ ...f, key: f.meta.thumbKey, url: f.meta.thumbUrl }, 600) : storage.urlFor(f, 600),
  }]));
}

// Opt-in from the consent ledger (a later opt-out wins); the enquiry checkbox when no record exists.
const buyerWhatsappOptIn = (l) => whatsappOptedIn([l.buyer && l.buyer.userId, l.buyer && l.buyer.contactId], l.whatsappOptIn);

function whatsappState(enabled, optedIn) {
  if (!enabled) return { allowed: false, code: 'WHATSAPP_DISABLED', reason: 'WhatsApp Business is not enabled' };
  if (!optedIn) return { allowed: false, code: 'WHATSAPP_NOT_OPTED_IN', reason: 'The buyer has not opted in to WhatsApp' };
  return { allowed: true };
}

// RE-K-08: approved WhatsApp templates sent by the agent to an opted-in buyer.
async function whatsappTemplate(user, id, body) {
  const d = z.object({ template: z.enum(['share_listing', 'visit_confirmation']), propertyId: oid.optional(), visitId: oid.optional() }).parse(body);
  const lead = await scopedLead(user, id);
  const enabled = await settings.get('whatsapp.enabled');
  const state = whatsappState(enabled, enabled && await buyerWhatsappOptIn(lead));
  if (!state.allowed) throw ApiError.conflict(state.reason, state.code);
  const agent = await User.findById(lead.assignedTo || user._id).select('name').lean();
  const vars = { name: lead.buyer.name ? lead.buyer.name.split(' ')[0] : 'there', agent: agent ? agent.name.split(' ')[0] : 'our agent', leadNo: lead.leadNo };
  const data = { template: d.template };
  if (d.template === 'share_listing') {
    const propertyId = d.propertyId || lead.propertyId;
    if (!propertyId) throw ApiError.validation([{ in: 'body', path: 'propertyId', message: 'Choose the property' }]);
    const p = await Property.findOne({ _id: propertyId, status: 'live' }).select('listingNo title slug').lean();
    if (!p) throw ApiError.validation([{ in: 'body', path: 'propertyId', message: 'Choose a live property' }]);
    Object.assign(vars, { title: p.title, listingNo: p.listingNo, link: `${env.CLIENT_URL}/property/${p.slug}` });
    data.listingNo = p.listingNo;
  } else {
    const v = d.visitId
      ? await SiteVisit.findOne({ _id: d.visitId, leadId: lead._id }).lean()
      : await SiteVisit.findOne({ leadId: lead._id, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $gte: new Date() } }).sort({ scheduledAt: 1 }).lean();
    if (!v || !['scheduled', 'confirmed'].includes(v.status)) throw ApiError.validation([{ in: 'body', path: 'visitId', message: 'Choose a scheduled visit' }]);
    const p = await Property.findById(v.propertyId).select('listingNo').lean();
    Object.assign(vars, { visitNo: v.visitNo, listingNo: p ? p.listingNo : '', meetingPoint: v.meetingPoint || 'At the property', when: new Date(v.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) });
    data.visitNo = v.visitNo;
  }
  const { template, render } = require('../notifications/service');
  const t = await template(`whatsapp.${d.template}`, 'whatsapp');
  const text = render(t.body, vars);
  const r = await sendWhatsapp({ to: lead.buyer.phone, text, template: d.template, vars });
  common.entry(lead, 'whatsapp', user._id, data);
  await lead.save();
  return { sent: true, template: d.template, provider: r.provider, text };
}

async function patch(user, id, body, req) {
  const d = z.object({
    priority: z.enum(['hot', 'warm', 'cold']).optional(),
    requirement: z.object({ purpose: z.enum(['sale', 'rent']).optional(), city: z.string().max(60).optional(), localities: z.array(z.string()).max(10).optional(), bhk: z.array(z.number().int()).max(6).optional(), budgetMin: z.number().min(0).optional(), budgetMax: z.number().min(0).optional(), timeline: z.string().max(40).optional(), loanNeeded: z.boolean().optional(), notes: z.string().max(1000).optional() }).optional(),
    name: z.string().trim().min(2).max(80).optional(),
  }).parse(body);
  const lead = await scopedLead(user, id);
  if (d.priority) lead.priority = d.priority;
  if (d.requirement) lead.requirement = { ...(lead.requirement ? lead.requirement.toObject() : {}), ...d.requirement };
  if (d.name) lead.buyer.name = d.name;
  common.entry(lead, 'updated', user._id, d);
  await lead.save();
  await audit(req, { action: 'lead.update', entityType: 'Lead', entityId: lead._id });
  return leadRow(lead.toObject());
}

async function stage(user, id, body) {
  const d = z.object({ stage: z.enum(['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation', 'booking', 'closed_won', 'closed_lost']), note: z.string().trim().max(500).optional(), lostReason: z.enum(['not_responding', 'budget_mismatch', 'bought_elsewhere', 'not_interested', 'duplicate', 'spam', 'property_sold', 'other']).optional(), lostNote: z.string().trim().max(500).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  if (d.stage === 'site_visit_scheduled' && !(await SiteVisit.exists({ leadId: lead._id, status: { $in: ['scheduled', 'confirmed'] } }))) throw ApiError.validation([{ in: 'body', path: 'stage', message: 'Schedule a site visit first' }]);
  await common.changeStage(lead, d.stage, user._id, d);
  await lead.save();
  return leadRow(lead.toObject());
}

async function callLog(user, id, body) {
  const d = z.object({ outcome: z.enum(['connected', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'call_back_later']), direction: z.enum(['outbound', 'inbound']).default('outbound'), durationSec: z.number().int().min(0).max(36000).optional(), note: z.string().trim().max(1000).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  lead.callAttempts = (lead.callAttempts || 0) + 1;
  common.entry(lead, 'call', user._id, d);
  if (d.outcome === 'connected') {
    lead.unansweredStreak = 0;
    if (lead.stage === 'new') await common.changeStage(lead, 'contacted', user._id, { note: 'Connected call' });
    if (!lead.firstContactAt) lead.firstContactAt = new Date();
  } else if (['no_answer', 'busy', 'switched_off'].includes(d.outcome)) {
    lead.unansweredStreak = (lead.unansweredStreak || 0) + 1;
    // Three unanswered calls in a row -> "not reachable" follow-up next working day 11:00.
    if (lead.unansweredStreak === 3) {
      // next working day (Mon-Sat) at 11:00 IST
      const ist = new Date(Date.now() + 330 * 60000);
      let at = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 11, 0) - 330 * 60000);
      if (new Date(at.getTime() + 330 * 60000).getUTCDay() === 0) at = new Date(at.getTime() + 86400000);
      await FollowUp.create({ leadId: lead._id, agentId: lead.assignedTo || user._id, type: 'call', dueAt: at, note: 'Not reachable after 3 attempts' });
    }
  }
  await lead.save();
  return { callAttempts: lead.callAttempts, stage: lead.stage };
}

async function note(user, id, body) {
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(body);
  const lead = await scopedLead(user, id);
  common.entry(lead, 'note', user._id, { text });
  await lead.save();
  return { ok: true };
}

async function linkProperty(user, id, body) {
  const { propertyId } = z.object({ propertyId: oid }).parse(body);
  const lead = await scopedLead(user, id);
  if (!(await Property.exists({ _id: propertyId, status: 'live' }))) throw ApiError.notFound('Live property not found');
  if (String(lead.propertyId) === propertyId || (lead.linkedProperties || []).some((x) => String(x) === propertyId)) return { linked: true };
  if ((lead.linkedProperties || []).length >= 10) throw ApiError.validation([{ in: 'body', path: 'propertyId', message: 'Up to 10 linked properties' }]);
  lead.linkedProperties.push(propertyId);
  common.entry(lead, 'property_linked', user._id, { propertyId });
  await lead.save();
  return { linked: true };
}

async function unlinkProperty(user, id, propertyId) {
  const lead = await scopedLead(user, id);
  lead.linkedProperties = (lead.linkedProperties || []).filter((x) => String(x) !== String(propertyId));
  common.entry(lead, 'property_unlinked', user._id, { propertyId });
  await lead.save();
  return { linked: false };
}

// RE-C-16: masked update to the lister ("Buyer N", contact details blocked).
async function shareUpdate(user, id, body, req) {
  const d = z.object({ propertyId: oid.optional(), text: z.string().trim().min(5).max(1000), tag: z.enum(['visit_outcome', 'interest', 'negotiation', 'general']).default('general'), amount: z.number().min(0).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  await guard.assertNoContactInfo({ text: d.text }, req);
  const propertyId = d.propertyId || lead.propertyId;
  if (!propertyId) throw ApiError.validation([{ in: 'body', path: 'propertyId', message: 'Choose the property' }]);
  const p = await Property.findById(propertyId).select('listerId listingNo').lean();
  const u = await ListerUpdate.create({ propertyId, leadId: lead._id, buyerLabel: lead.buyerLabel || 'A buyer', text: d.text, tag: d.tag, amount: d.amount ? Math.round(d.amount * 100) : undefined, by: user._id });
  common.entry(lead, 'share', user._id, { tag: d.tag, text: d.text });
  await lead.save();
  const lister = await User.findById(p.listerId);
  if (lister) await notifyUser({ user: lister, event: 'lister.update_shared', channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, buyerLabel: u.buyerLabel, text: d.text } });
  return u;
}

async function reassignRequest(user, id, body) {
  const { reason } = z.object({ reason: z.string().trim().min(5).max(300) }).parse(body);
  const lead = await scopedLead(user, id);
  if ((lead.reassignRequests || []).some((r) => r.status === 'open')) throw ApiError.conflict('A request is already open', 'DUPLICATE');
  lead.reassignRequests.push({ reason, by: user._id });
  common.entry(lead, 'reassign_requested', user._id, { reason });
  await lead.save();
  const { Team } = require('../teams/models');
  const team = lead.teamId && await Team.findById(lead.teamId);
  const managers = team ? await User.find({ _id: { $in: team.managerIds } }) : [];
  for (const m of managers) await notifyUser({ user: m, event: 'lead.reassign_requested', vars: { leadNo: lead.leadNo, leadId: String(lead._id), reason } });
  return { requested: true };
}

// ---------------------------------------------------------------- follow-ups (RE-C-09)

const fuSchema = z.object({ leadId: oid, type: z.enum(['call', 'whatsapp', 'meeting', 'email', 'other']).default('call'), dueAt: z.coerce.date(), remindBeforeMin: z.number().int().min(0).max(1440).default(15), note: z.string().trim().max(500).optional() });

async function followups(user) {
  const { start, end } = dayBounds();
  const base = { agentId: user._id };
  const pop = { path: 'leadId', select: 'leadNo buyer.name stage priority' };
  const [overdue, today, upcoming, done] = await Promise.all([
    FollowUp.find({ ...base, status: 'open', dueAt: { $lt: start } }).sort({ dueAt: 1 }).populate(pop).lean(),
    FollowUp.find({ ...base, status: 'open', dueAt: { $gte: start, $lt: end } }).sort({ dueAt: 1 }).populate(pop).lean(),
    FollowUp.find({ ...base, status: 'open', dueAt: { $gte: end } }).sort({ dueAt: 1 }).limit(100).populate(pop).lean(),
    FollowUp.find({ ...base, status: 'done' }).sort({ doneAt: -1 }).limit(30).populate(pop).lean(),
  ]);
  return { overdue, today, upcoming, done };
}

async function scheduleFollowupReminder(f, remindBeforeMin) {
  const jobs = require('../../core/jobs');
  const at = f.dueAt.getTime() - remindBeforeMin * 60000;
  if (at > Date.now()) await jobs.enqueue('followup.reminder', { followUpId: String(f._id) }, { delayMs: at - Date.now(), uniqueKey: `fu:${f._id}:${at}` });
}

async function createFollowup(user, body) {
  const d = fuSchema.parse(body);
  const lead = await scopedLead(user, d.leadId);
  const f = await FollowUp.create({ leadId: lead._id, agentId: lead.assignedTo || user._id, type: d.type, dueAt: d.dueAt, remindAt: new Date(d.dueAt.getTime() - d.remindBeforeMin * 60000), note: d.note });
  common.entry(lead, 'followup', user._id, { type: d.type, dueAt: d.dueAt });
  await lead.save();
  await scheduleFollowupReminder(f, d.remindBeforeMin);
  return f;
}

async function bulkFollowups(user, body) {
  const d = fuSchema.omit({ leadId: true }).extend({ leadIds: z.array(oid).min(1).max(100) }).parse(body);
  const out = [];
  for (const leadId of d.leadIds) out.push(await createFollowup(user, { ...d, leadId }));
  return { created: out.length };
}

async function editFollowup(user, id, body) {
  const d = fuSchema.omit({ leadId: true }).partial().parse(body);
  const f = await FollowUp.findOne({ _id: id, agentId: user._id, status: 'open' });
  if (!f) throw ApiError.notFound('Follow-up not found');
  Object.assign(f, { ...(d.type ? { type: d.type } : {}), ...(d.dueAt ? { dueAt: d.dueAt } : {}), ...(d.note !== undefined ? { note: d.note } : {}) });
  await f.save();
  if (d.dueAt) await scheduleFollowupReminder(f, d.remindBeforeMin ?? 15);
  return f;
}

async function completeFollowup(user, id, body) {
  const d = z.object({ outcome: z.string().trim().min(2).max(300), next: z.object({ dueAt: z.coerce.date(), type: z.enum(['call', 'whatsapp', 'meeting', 'email', 'other']).default('call'), note: z.string().max(500).optional() }).optional() }).parse(body);
  const f = await FollowUp.findOne({ _id: id, agentId: user._id, status: 'open' });
  if (!f) throw ApiError.notFound('Follow-up not found');
  f.status = 'done'; f.outcome = d.outcome; f.doneAt = new Date();
  await f.save();
  const lead = await Lead.findById(f.leadId);
  common.entry(lead, 'followup_done', user._id, { outcome: d.outcome });
  await lead.save();
  const next = d.next ? await createFollowup(user, { leadId: String(f.leadId), ...d.next }) : null;
  return { done: true, next };
}

// ---------------------------------------------------------------- site visits (RE-C-12..15)

async function calendar(user, query) {
  const from = query.from ? new Date(query.from) : dayBounds().start;
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 7 * 86400000);
  const filter = { scheduledAt: { $gte: from, $lt: to } };
  if (user.role === 'manager' && query.team === 'true') {
    const teams = await reveal.managedTeamIds(user);
    const { Team } = require('../teams/models');
    const agents = (await Team.find({ _id: { $in: teams } }).lean()).flatMap((t) => t.members.map((m) => m.agentId));
    filter.agentId = { $in: [user._id, ...agents] };
  } else filter.agentId = user._id;
  const requested = await SiteVisit.find({ agentId: user._id, status: 'requested' }).populate('propertyId', 'listingNo title location.locality').populate('leadId', 'leadNo buyer.name').lean();
  const items = await SiteVisit.find({ ...filter, status: { $ne: 'requested' } }).sort({ scheduledAt: 1 }).populate('propertyId', 'listingNo title location.locality location.addressLine').populate('leadId', 'leadNo buyer.name').lean();
  return { from, to, items, requested };
}

const isLead = (role) => ['manager', 'admin', 'superadmin'].includes(role);

async function validateVisit(user, { agentId, propertyId, scheduledAt, durationMin, overrideReason, excludeId }) {
  const p = await Property.findById(propertyId).select('listerId status listingNo').lean();
  if (!p) throw ApiError.notFound('Property not found');
  if (!['live', 'paused'].includes(p.status)) throw ApiError.conflict('Visits can only be scheduled on live listings', 'PROPERTY_NOT_LIVE');
  const clash = await SiteVisit.findOne({ _id: { $ne: excludeId }, agentId, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $lt: new Date(scheduledAt.getTime() + durationMin * 60000), $gt: new Date(scheduledAt.getTime() - durationMin * 60000) } }).select('visitNo').lean();
  if (clash) throw ApiError.conflict(`The agent already has visit ${clash.visitNo} at this time`, 'VISIT_OVERLAP');
  const c = await slots.checkSlot(scheduledAt, { listerId: p.listerId, propertyId });
  let outside = false;
  if (!c.ok) {
    if (!(isLead(user.role) && overrideReason)) throw ApiError.validation([{ in: 'body', path: 'scheduledAt', message: c.reason }]);
    outside = true;
  }
  return { p, outside };
}

async function notifyScheduled(v, lead, p, event, { reason } = {}) {
  const token = crypto.randomBytes(18).toString('base64url');
  v.confirmTokenHash = buyerSvc.sha(token);
  await v.save();
  const when = v.scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const agent = await User.findById(v.agentId).select('name').lean();
  const vars = { visitNo: v.visitNo, when, meetingPoint: v.meetingPoint || 'At the property', note: v.buyerNote ? ` Note: ${v.buyerNote}.` : '', agent: agent ? agent.name.split(' ')[0] : 'our agent', link: `${env.CLIENT_URL}/visit/${token}`, listingNo: p.listingNo };
  await notifyLeadBuyer(lead, { event, channels: ['in_app', 'email', 'sms'], vars }); // WhatsApp when opted in (RE-K-08)
  const lister = await User.findById(p.listerId);
  if (lister) {
    const listerEvent = reason ? 'sitevisit.lister_rescheduled' : 'sitevisit.lister_planned';
    await notifyUser({ user: lister, event: listerEvent, channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, when, buyerLabel: lead.buyerLabel || 'A buyer', reason: reason || '' } });
  }
  return token;
}

async function scheduleVisit(user, body) {
  const d = z.object({ leadId: oid, propertyId: oid, scheduledAt: z.coerce.date(), durationMin: z.number().int().min(15).max(180).default(30), meetingPoint: z.string().trim().max(200).optional(), buyerNote: z.string().trim().max(300).optional(), pickup: z.object({ needed: z.boolean(), address: z.string().max(300).optional() }).optional(), overrideReason: z.string().trim().max(300).optional(), visitId: oid.optional() }).parse(body);
  const lead = await scopedLead(user, d.leadId);
  const agentId = lead.assignedTo || user._id;
  const { p, outside } = await validateVisit(user, { agentId, propertyId: d.propertyId, scheduledAt: d.scheduledAt, durationMin: d.durationMin, overrideReason: d.overrideReason, excludeId: d.visitId });
  let v = d.visitId ? await SiteVisit.findOne({ _id: d.visitId, leadId: lead._id, status: 'requested' }) : await SiteVisit.findOne({ leadId: lead._id, propertyId: d.propertyId, status: 'requested' });
  if (!v) v = new SiteVisit({ visitNo: await counters.visitNo(), leadId: lead._id, propertyId: d.propertyId });
  Object.assign(v, { agentId, scheduledAt: d.scheduledAt, durationMin: d.durationMin, meetingPoint: d.meetingPoint, buyerNote: d.buyerNote, pickup: d.pickup, status: 'scheduled', outsideListerSlots: outside || undefined, overrideReason: outside ? d.overrideReason : undefined });
  await v.save();
  if (!lead.linkedProperties.some((x) => String(x) === d.propertyId) && String(lead.propertyId) !== d.propertyId) lead.linkedProperties.push(d.propertyId);
  common.entry(lead, 'visit', user._id, { visitNo: v.visitNo, status: 'scheduled', at: d.scheduledAt, outsideListerSlots: outside });
  if (common.STAGE_ORDER.indexOf(lead.stage) < common.STAGE_ORDER.indexOf('site_visit_scheduled')) await common.changeStage(lead, 'site_visit_scheduled', user._id, { note: 'Visit scheduled' });
  await lead.save();
  await Property.updateOne({ _id: d.propertyId }, { $inc: { 'stats.visits': 1 } });
  await notifyScheduled(v, lead, p, 'sitevisit.scheduled');
  await buyerSvc.scheduleReminders(v);
  return v;
}

async function ownVisit(user, id) {
  const v = await SiteVisit.findById(id);
  if (!v) throw ApiError.notFound('Visit not found');
  const lead = await scopedLead(user, v.leadId);
  return { v, lead };
}

async function rescheduleVisit(user, id, body, req) {
  const d = z.object({ scheduledAt: z.coerce.date().optional(), rescheduleReason: z.string().trim().min(3).max(300).optional(), meetingPoint: z.string().trim().max(200).optional(), buyerNote: z.string().trim().max(300).optional(), pickup: z.object({ needed: z.boolean(), address: z.string().max(300).optional() }).optional(), overrideReason: z.string().trim().max(300).optional() }).parse(body);
  const { v, lead } = await ownVisit(user, id);
  if (!['scheduled', 'confirmed'].includes(v.status)) throw ApiError.conflict(`A ${v.status} visit cannot be changed`, 'INVALID_TRANSITION');
  if (d.scheduledAt && d.scheduledAt.getTime() !== v.scheduledAt.getTime()) {
    if (!d.rescheduleReason) throw ApiError.validation([{ in: 'body', path: 'rescheduleReason', message: 'Give the reason for moving the visit' }]);
    await guard.assertNoContactInfo({ rescheduleReason: d.rescheduleReason }, req); // the reason reaches the lister
    if (v.rescheduleCount >= await settings.get('visit.maxReschedules')) throw ApiError.conflict('Maximum reschedules reached; cancel and book a new visit', 'RESCHEDULE_LIMIT');
    const { p, outside } = await validateVisit(user, { agentId: v.agentId, propertyId: v.propertyId, scheduledAt: d.scheduledAt, durationMin: v.durationMin, overrideReason: d.overrideReason, excludeId: v._id });
    v.history.push({ kind: 'rescheduled', from: v.scheduledAt, to: d.scheduledAt, reason: d.rescheduleReason, by: user._id, at: new Date() });
    Object.assign(v, { scheduledAt: d.scheduledAt, status: 'scheduled', rescheduleCount: v.rescheduleCount + 1, outsideListerSlots: outside || undefined, overrideReason: outside ? d.overrideReason : undefined, rescheduleRequest: undefined });
    common.entry(lead, 'visit', user._id, { visitNo: v.visitNo, status: 'rescheduled', at: d.scheduledAt, reason: d.rescheduleReason });
    await lead.save();
    await notifyScheduled(v, lead, p, 'sitevisit.rescheduled', { reason: d.rescheduleReason });
    await buyerSvc.scheduleReminders(v);
  }
  if (d.meetingPoint !== undefined) v.meetingPoint = d.meetingPoint;
  if (d.buyerNote !== undefined) v.buyerNote = d.buyerNote;
  if (d.pickup) v.pickup = d.pickup;
  await v.save();
  return v;
}

async function confirmVisit(user, id) { const { v, lead } = await ownVisit(user, id); return buyerSvc.confirm(v, lead, user._id); }

async function cancelVisit(user, id, body) {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(body);
  const { v, lead } = await ownVisit(user, id);
  if (!['requested', 'scheduled', 'confirmed'].includes(v.status)) throw ApiError.conflict(`This visit is ${v.status}`, 'INVALID_TRANSITION');
  v.status = 'cancelled'; v.cancelReason = reason;
  await v.save();
  common.entry(lead, 'visit', user._id, { visitNo: v.visitNo, status: 'cancelled', reason });
  if (lead.stage === 'site_visit_scheduled' && !(await SiteVisit.exists({ leadId: lead._id, status: { $in: ['scheduled', 'confirmed'] } }))) await common.changeStage(lead, 'qualified', user._id, { note: 'Visit cancelled', system: true });
  await lead.save();
  return v;
}

async function outcome(user, id, body, req) {
  const d = z.object({
    result: z.enum(['completed', 'no_show']), interest: z.number().int().min(1).max(5).optional(), rating: z.number().int().min(1).max(5).optional(),
    objections: z.array(z.string().max(40)).max(10).default([]), feedback: z.string().trim().max(1000).optional(), offerAmount: z.number().min(0).optional(),
    nextStep: z.string().trim().max(300).optional(), shareWithLister: z.boolean().default(false), listerSummary: z.string().trim().max(500).optional(),
    photoFileIds: z.array(oid).max(10).default([]),
  }).parse(body);
  const { v, lead } = await ownVisit(user, id);
  if (!['scheduled', 'confirmed'].includes(v.status)) throw ApiError.conflict(`A ${v.status} visit cannot take an outcome`, 'INVALID_TRANSITION');
  if (v.scheduledAt > new Date()) throw ApiError.conflict('The visit has not happened yet', 'VISIT_IN_FUTURE');
  const photoIds = [...new Set(d.photoFileIds)];
  if (photoIds.length) {
    // Photos are uploaded by this agent with purpose verification_photo (private, signed URLs).
    const storage = require('../../core/storage');
    const n = await storage.FileModel.countDocuments({ _id: { $in: photoIds }, ownerId: user._id, purpose: 'verification_photo' });
    if (n !== photoIds.length) throw ApiError.validation([{ in: 'body', path: 'photoFileIds', message: 'Upload the photos yourself (purpose verification_photo) and send their ids' }]);
  }
  v.status = d.result;
  v.outcome = { result: d.result, interest: d.interest, rating: d.rating, objections: d.objections, feedback: d.feedback, offerAmount: d.offerAmount ? Math.round(d.offerAmount * 100) : undefined, nextStep: d.nextStep, photos: photoIds, recordedAt: new Date() };
  v.sharedWithLister = d.shareWithLister;
  await v.save();
  common.entry(lead, 'visit', user._id, { visitNo: v.visitNo, status: d.result, interest: d.interest, nextStep: d.nextStep, ...(photoIds.length ? { photos: photoIds.length } : {}) });
  if (d.result === 'completed') {
    if (common.STAGE_ORDER.indexOf(lead.stage) < common.STAGE_ORDER.indexOf('site_visit_done')) await common.changeStage(lead, 'site_visit_done', user._id, { system: true, note: 'Visit completed' });
    const token = crypto.randomBytes(18).toString('base64url');
    v.feedback = { tokenHash: buyerSvc.sha(token) };
    await v.save();
    const jobs = require('../../core/jobs');
    await jobs.enqueue('sitevisit.feedback_request', { visitId: String(v._id), token }, { delayMs: (await settings.get('visit.feedbackDelayHours')) * 3600000, uniqueKey: `feedback:${v._id}` });
  } else if (lead.stage === 'site_visit_scheduled') {
    await common.changeStage(lead, 'qualified', user._id, { system: true, note: 'Buyer did not show up' });
    await FollowUp.create({ leadId: lead._id, agentId: v.agentId, type: 'call', dueAt: new Date(Date.now() + 3 * 3600000), note: `No-show at ${v.visitNo}` });
  }
  await lead.save();
  if (d.shareWithLister && d.result === 'completed') {
    await shareUpdate(user, String(lead._id), { propertyId: String(v.propertyId), tag: 'visit_outcome', text: d.listerSummary || `Visit completed. Interest ${d.interest || '-'} of 5.${d.nextStep ? ` Next: ${d.nextStep}` : ''}` }, req);
  }
  return v;
}

// ---------------------------------------------------------------- property lookup, sales sheet, matches

async function propertySearch(query) {
  const search = require('../search/service');
  const { filter } = await search.buildFilter({ ...query, ...(query.status ? {} : {}) });
  if (query.q && /^re\d{2}-\d{6}$/i.test(query.q.trim())) { delete filter.$text; filter.listingNo = query.q.trim().toUpperCase(); }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const items = await Property.find(filter).sort({ liveAt: -1 }).skip((page - 1) * 20).limit(20).lean();
  const cards = await search.cards(items);
  return cards.map((c, i) => ({ ...c, stats: items[i].stats }));
}

async function salesSheet(user, id) {
  if (!(await reveal.propertyInScope(user, id))) throw ApiError.forbidden('Open the sales sheet from one of your leads', 'OUT_OF_SCOPE');
  const p = await Property.findById(id).populate('activeAgreementId', 'agreementNo commissionPercent basis').lean();
  if (!p) throw ApiError.notFound('Property not found');
  const lister = await User.findById(p.listerId).select('name listerType brand kyc.status').lean();
  const [offers, visits, av] = await Promise.all([
    Offer.find({ propertyId: p._id, status: { $in: ['awaiting_lister', 'awaiting_buyer', 'accepted'] } }).select('offerNo status buyerLabel rounds validUntil').lean(),
    SiteVisit.find({ propertyId: p._id }).sort({ scheduledAt: -1 }).limit(20).select('visitNo status scheduledAt outcome.interest agentId').lean(),
    slots.availabilityFor(p.listerId, { propertyId: p._id }),
  ]);
  return {
    _id: p._id, listingNo: p.listingNo, title: p.title, status: p.status, purpose: p.purpose, type: p.type, details: p.details, price: p.price, amenities: p.amenities,
    address: { societyName: p.location.societyName, addressLine: p.location.addressLine, unitNo: p.location.unitNo, locality: p.location.locality, city: p.location.city, pincode: p.location.pincode, geo: p.location.geo, landmarks: p.location.landmarks },
    lister: { name: lister.name, type: lister.listerType, brand: lister.brand && lister.brand.name, kycStatus: lister.kyc && lister.kyc.status, contactHint: 'Use Reveal contact; every reveal is logged' },
    commission: { percent: p.commission && p.commission.percent, agreementNo: p.activeAgreementId && p.activeAgreementId.agreementNo },
    availability: av ? { weekly: av.weekly, blackouts: av.blackouts, noticeHours: av.noticeHours, note: av.note } : null,
    openOffers: offers, visits, media: { photos: (p.media && p.media.photos || []).map((x) => ({ url: x.thumbUrl || x.url })) }, stats: p.stats,
  };
}

async function agentSlots(user, propertyId, query) {
  const p = await Property.findById(propertyId).select('listerId').lean();
  if (!p) throw ApiError.notFound('Property not found');
  return slots.slots({ listerId: p.listerId, propertyId }, query);
}

async function matches(user, id) {
  const lead = await scopedLead(user, id);
  const r = lead.requirement || {};
  const search = require('../search/service');
  const base = lead.propertyId ? await Property.findById(lead.propertyId).lean() : null;
  const filters = {
    purpose: r.purpose || (base && base.purpose), city: r.city || (base && base.location.city),
    ...((r.bhk || []).length ? { bhk: r.bhk.join(',') } : base && base.details && base.details.bhk != null ? { bhk: String(base.details.bhk) } : {}),
    ...(r.budgetMax ? { maxPrice: r.budgetMax } : base ? { maxPrice: Math.round(((base.price.amount || base.price.monthlyRent) * 1.2) / 100) } : {}),
    ...((r.localities || []).length ? { localities: r.localities.join(',') } : {}),
  };
  const { filter } = await search.buildFilter(filters);
  filter._id = { $nin: [lead.propertyId, ...(lead.linkedProperties || [])].filter(Boolean) };
  const items = await Property.find(filter).sort({ liveAt: -1 }).limit(10).lean();
  return { filters, items: await search.cards(items) };
}

async function shareListings(user, id, body) {
  const { propertyIds, note } = z.object({ propertyIds: z.array(oid).min(1).max(5), note: z.string().trim().max(300).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  const props = await Property.find({ _id: { $in: propertyIds }, status: 'live' }).select('listingNo title slug').lean();
  if (!props.length) throw ApiError.validation([{ in: 'body', path: 'propertyIds', message: 'Choose live properties' }]);
  const list = props.map((p) => `${p.title} (${p.listingNo}): ${env.CLIENT_URL}/property/${p.slug}`).join('\n');
  const vars = { list, note: note || '', leadNo: lead.leadNo };
  if (lead.buyer.userId) { const u = await User.findById(lead.buyer.userId); if (u) await notifyUser({ user: u, event: 'lead.listings_shared', channels: ['email', 'in_app'], vars }); } else {
    await sendNow({ channel: lead.buyer.email ? 'email' : 'sms', to: lead.buyer.email || lead.buyer.phone, event: 'lead.listings_shared', vars }).catch(() => {});
  }
  props.forEach((p) => { if (!lead.linkedProperties.some((x) => String(x) === String(p._id)) && String(lead.propertyId) !== String(p._id) && lead.linkedProperties.length < 10) lead.linkedProperties.push(p._id); });
  common.entry(lead, 'listings_shared', user._id, { listings: props.map((p) => p.listingNo) });
  await lead.save();
  return { shared: props.length };
}

// ---------------------------------------------------------------- offers (C6, RE-C-20)

async function recordOffer(user, id, body) {
  const d = z.object({ propertyId: oid.optional(), amount: z.number().positive(), terms: z.object({ token: z.number().min(0).optional(), possessionDate: z.coerce.date().optional(), inclusions: z.string().max(300).optional() }).default({}), validityDays: z.number().int().min(1).max(7).optional(), note: z.string().trim().max(500).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  const propertyId = d.propertyId || lead.propertyId;
  if (!propertyId) throw ApiError.validation([{ in: 'body', path: 'propertyId', message: 'Choose the property' }]);
  if (!['site_visit_done', 'negotiation', 'qualified', 'contacted', 'site_visit_scheduled'].includes(lead.stage)) throw ApiError.conflict(`A ${lead.stage} lead cannot take an offer`, 'INVALID_STAGE');
  const p = await Property.findById(propertyId).select('listerId listingNo status').lean();
  if (!p) throw ApiError.notFound('Property not found');
  if (await Offer.exists({ leadId: lead._id, propertyId, status: { $in: ['awaiting_lister', 'awaiting_buyer'] } })) throw ApiError.conflict('This lead already has an open offer on this property', 'OFFER_OPEN');
  const days = d.validityDays || await settings.get('offer.expiryDays');
  const o = await Offer.create({
    offerNo: await counters.offerNo(), leadId: lead._id, propertyId, listerId: p.listerId, agentId: lead.assignedTo || user._id, buyerLabel: lead.buyerLabel || 'A buyer',
    status: 'awaiting_lister', validUntil: new Date(Date.now() + days * 86400000),
    rounds: [{ n: 1, by: 'agent', kind: 'offer', amount: Math.round(d.amount * 100), terms: { ...d.terms, token: d.terms.token ? Math.round(d.terms.token * 100) : undefined }, note: d.note }],
  });
  common.entry(lead, 'offer', user._id, { offerNo: o.offerNo, round: 1, by: 'agent', kind: 'offer', amount: Math.round(d.amount * 100) });
  if (lead.stage === 'site_visit_done') await common.changeStage(lead, 'negotiation', user._id, { system: true, note: 'Offer recorded' });
  await lead.save();
  await Property.updateOne({ _id: propertyId }, { $inc: { 'stats.offers': 1 } });
  const lister = await User.findById(p.listerId);
  if (lister) await notifyUser({ user: lister, event: 'offer.received', channels: ['in_app', 'email', 'sms'], vars: { offerNo: o.offerNo, listingNo: p.listingNo, buyerLabel: o.buyerLabel, amount: `INR ${d.amount.toLocaleString('en-IN')}`, by: o.validUntil.toDateString() } });
  return o;
}

async function agentOffer(user, id) {
  const o = await Offer.findById(id);
  if (!o) throw ApiError.notFound('Offer not found');
  await scopedLead(user, o.leadId);
  return o;
}

async function buyerRound(user, id, body) {
  const d = z.object({ kind: z.enum(['accept', 'counter']), amount: z.number().positive().optional(), note: z.string().trim().max(500).optional() }).parse(body);
  const o = await agentOffer(user, id);
  if (o.status !== 'awaiting_buyer') throw ApiError.conflict('The owner has not countered yet', 'INVALID_TRANSITION');
  const last = o.rounds[o.rounds.length - 1];
  if (!last.relayedToBuyerAt) throw ApiError.conflict('Mark the owner\'s counter as relayed to the buyer first', 'NOT_RELAYED');
  if (o.rounds.length >= await settings.get('offer.maxRounds')) throw ApiError.conflict('Maximum rounds reached', 'ROUND_LIMIT');
  if (d.kind === 'counter' && !d.amount) throw ApiError.validation([{ in: 'body', path: 'amount', message: 'Enter the buyer\'s new amount' }]);
  o.rounds.push({ n: o.rounds.length + 1, by: 'agent', kind: d.kind, amount: d.kind === 'accept' ? last.amount : Math.round(d.amount * 100), note: d.note });
  o.status = d.kind === 'accept' ? 'accepted' : 'awaiting_lister';
  await o.save();
  const lead = await Lead.findById(o.leadId);
  common.entry(lead, 'offer', user._id, { offerNo: o.offerNo, round: o.rounds.length, by: 'agent', kind: d.kind, amount: o.rounds[o.rounds.length - 1].amount });
  await lead.save();
  const lister = await User.findById(o.listerId);
  if (lister) await notifyUser({ user: lister, event: 'offer.buyer_responded', channels: ['in_app', 'email'], vars: { offerNo: o.offerNo, buyerLabel: o.buyerLabel, kind: d.kind === 'accept' ? 'accepted your counter' : 'made a new offer' } });
  return o;
}

async function relay(user, id) {
  const o = await agentOffer(user, id);
  const last = o.rounds[o.rounds.length - 1];
  if (!last || last.by !== 'lister') throw ApiError.conflict('Nothing from the owner to relay', 'INVALID_TRANSITION');
  last.relayedToBuyerAt = new Date();
  o.markModified('rounds');
  await o.save();
  const lead = await Lead.findById(o.leadId);
  common.entry(lead, 'offer_relayed', user._id, { offerNo: o.offerNo, round: last.n });
  await lead.save();
  return o;
}

async function withdraw(user, id, body) {
  const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(body || {});
  const o = await agentOffer(user, id);
  if (!['awaiting_lister', 'awaiting_buyer'].includes(o.status)) throw ApiError.conflict(`A ${o.status} offer cannot be withdrawn`, 'INVALID_TRANSITION');
  o.rounds.push({ n: o.rounds.length + 1, by: 'agent', kind: 'withdraw', note });
  o.status = 'withdrawn';
  await o.save();
  const lead = await Lead.findById(o.leadId);
  common.entry(lead, 'offer', user._id, { offerNo: o.offerNo, kind: 'withdraw' });
  await lead.save();
  const lister = await User.findById(o.listerId);
  if (lister) await notifyUser({ user: lister, event: 'offer.closed', vars: { offerNo: o.offerNo, status: 'withdrawn by the buyer' } });
  return o;
}

// RE-C-22 masked calls (Could): only when a telephony provider is configured.
async function maskedCall(user, kind, id) {
  if (!(await settings.get('telephony.enabled')) || env.TELEPHONY_PROVIDER === 'none') {
    return { mode: 'fallback', message: 'Masked calling is not enabled. Use your phone and log the call.', tel: null };
  }
  throw ApiError.notImplemented('RE-C-22:masked-call');
}

module.exports = {
  dashboard, list, board, manualLead, detail, patch, whatsappTemplate, stage, callLog, note, linkProperty, unlinkProperty, shareUpdate, reassignRequest,
  followups, createFollowup, bulkFollowups, editFollowup, completeFollowup,
  calendar, scheduleVisit, rescheduleVisit, confirmVisit, cancelVisit, outcome,
  propertySearch, salesSheet, agentSlots, matches, shareListings, recordOffer, buyerRound, relay, withdraw, maskedCall, scopeFilter, leadRow, attachProperties,
};
