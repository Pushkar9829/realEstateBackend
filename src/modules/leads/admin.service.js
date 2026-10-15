// Admin / manager side of Module C (RE-C-06/07): all leads (managers see their
// teams only, RE-J-07), assign / bulk assign, reopen, recycle, merge, queue
// panels, reassignment requests, CSV export and site visit oversight.
const { z } = require('zod');
const { Lead, SiteVisit, FollowUp, Offer } = require('./models');
const { User } = require('../auth/models');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const reveal = require('../masking/reveal.service');
const common = require('./common');
const agentSvc = require('./agent.service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);

async function scope(user) {
  if (user.role !== 'manager') return {};
  return { teamId: { $in: await reveal.managedTeamIds(user) } };
}

async function scopedLead(user, id) {
  const lead = await Lead.findOne({ _id: id, ...(await scope(user)) });
  if (!lead) throw ApiError.notFound('Lead not found');
  return lead;
}

async function list(user, query) {
  const filter = { ...(await scope(user)), mergedInto: null };
  if (query.stage) filter.stage = { $in: String(query.stage).split(',') };
  if (query.agentId) filter.assignedTo = query.agentId === 'none' ? null : query.agentId;
  if (query.teamId) filter.teamId = query.teamId;
  if (query.source) filter.sources = query.source;
  if (query.priority) filter.priority = query.priority;
  if (query.breached === 'true') filter.slaBreachedAt = { $ne: null };
  if (query.from || query.to) filter.createdAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ leadNo: rx }, { 'buyer.name': rx }, { 'buyer.phone': rx }];
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, parseInt(query.limit, 10) || 25);
  const [items, total] = await Promise.all([Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('assignedTo', 'name').populate('teamId', 'name').lean(), Lead.countDocuments(filter)]);
  const rows = await agentSvc.attachProperties(items.map((l) => ({ ...agentSvc.leadRow(l), agent: l.assignedTo && l.assignedTo.name, team: l.teamId && l.teamId.name })));
  return { items: rows, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function detail(user, id) {
  await scopedLead(user, id);
  return agentSvc.detail({ ...user.toObject ? user.toObject() : user, role: 'superadmin', permissions: user.permissions }, id);
}

async function assertAssignable(user, agentId, teamId) {
  const agent = await User.findOne({ _id: agentId, role: { $in: ['agent', 'manager'] }, status: 'active' });
  if (!agent) throw ApiError.validation([{ in: 'body', path: 'agentId', message: 'Choose an active agent' }]);
  const { Team } = require('../teams/models');
  const team = await Team.findOne({ 'members.agentId': agentId });
  if (user.role === 'manager') {
    const mine = (await reveal.managedTeamIds(user)).map(String);
    if (!team || !mine.includes(String(team._id))) throw ApiError.forbidden('You can assign only to agents in your teams', 'OUT_OF_SCOPE');
  }
  return team || (teamId && await Team.findById(teamId));
}

async function assignOne(user, lead, agentId, reason) {
  const team = await assertAssignable(user, agentId, lead.teamId);
  await common.assign(lead, agentId, user._id, { team, note: reason || 'Assigned by manager' });
  await FollowUp.updateMany({ leadId: lead._id, status: 'open' }, { $set: { agentId } });
  await SiteVisit.updateMany({ leadId: lead._id, status: { $in: ['requested', 'scheduled', 'confirmed'] } }, { $set: { agentId } });
  await Offer.updateMany({ leadId: lead._id, status: { $in: ['awaiting_lister', 'awaiting_buyer'] } }, { $set: { agentId } });
  await lead.save();
}

async function assign(user, id, body, req) {
  const d = z.object({ agentId: oid, reason: z.string().trim().max(300).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  await assignOne(user, lead, d.agentId, d.reason);
  await audit(req, { action: 'lead.assign', entityType: 'Lead', entityId: lead._id, after: { agentId: d.agentId }, reason: d.reason });
  return agentSvc.leadRow(lead.toObject());
}

async function bulkAssign(user, body, req) {
  const d = z.object({ leadIds: z.array(oid).min(1).max(200), agentId: oid, reason: z.string().trim().max(300).optional() }).parse(body);
  let done = 0;
  for (const id of d.leadIds) {
    const lead = await Lead.findOne({ _id: id, ...(await scope(user)) });
    if (lead) { await assignOne(user, lead, d.agentId, d.reason); done += 1; }
  }
  await audit(req, { action: 'lead.bulk_assign', entityType: 'Lead', after: { count: done, agentId: d.agentId } });
  return { assigned: done };
}

async function reopen(user, id, body, req) {
  const { note } = z.object({ note: z.string().trim().min(3).max(300) }).parse(body);
  const lead = await scopedLead(user, id);
  if (lead.stage !== 'closed_lost') throw ApiError.conflict('Only lost leads can be reopened', 'INVALID_TRANSITION');
  const days = await settings.get('lead.reopenDays');
  if (lead.closedAt && Date.now() - lead.closedAt.getTime() > days * 86400000) throw ApiError.conflict(`Lost more than ${days} days ago; recycle it as a new lead instead`, 'REOPEN_WINDOW');
  const to = lead.previousStage && common.OPEN_STAGES.includes(lead.previousStage) ? lead.previousStage : 'contacted';
  lead.stage = to; lead.closedAt = undefined; lead.lostReason = undefined;
  common.entry(lead, 'stage', user._id, { from: 'closed_lost', to, note: `Reopened: ${note}` });
  await lead.save();
  await audit(req, { action: 'lead.reopen', entityType: 'Lead', entityId: lead._id, reason: note });
  return agentSvc.leadRow(lead.toObject());
}

async function recycle(user, id, req) {
  const old = await scopedLead(user, id);
  if (old.stage !== 'closed_lost') throw ApiError.conflict('Only lost leads can be recycled', 'INVALID_TRANSITION');
  const days = await settings.get('lead.reopenDays');
  if (old.closedAt && Date.now() - old.closedAt.getTime() < days * 86400000) throw ApiError.conflict(`Lost less than ${days} days ago; reopen it instead`, 'RECYCLE_WINDOW');
  const lead = new Lead({ leadNo: await counters.leadNo(), buyer: old.buyer, propertyId: old.propertyId, projectId: old.projectId, sources: ['recycled'], requirement: old.requirement, buyerLabel: old.buyerLabel, referralCode: old.referralCode, consentAt: old.consentAt, recycledFrom: old._id });
  common.entry(lead, 'created', user._id, { type: 'recycled', from: old.leadNo });
  await common.route(lead, { city: old.requirement && old.requirement.city, purpose: old.requirement && old.requirement.purpose, source: 'recycled' });
  await lead.save();
  common.entry(old, 'recycled', user._id, { into: lead.leadNo });
  await old.save();
  await audit(req, { action: 'lead.recycle', entityType: 'Lead', entityId: lead._id, after: { from: old.leadNo } });
  return agentSvc.leadRow(lead.toObject());
}

async function merge(user, id, body, req) {
  const { intoLeadId } = z.object({ intoLeadId: oid }).parse(body);
  if (id === intoLeadId) throw ApiError.validation([{ in: 'body', path: 'intoLeadId', message: 'Choose a different lead' }]);
  const from = await scopedLead(user, id);
  const into = await scopedLead(user, intoLeadId);
  if (from.buyer.phone !== into.buyer.phone) throw ApiError.conflict('Only leads of the same buyer can be merged', 'DIFFERENT_BUYER');
  into.sources = [...new Set([...into.sources, ...from.sources])];
  into.linkedProperties = [...new Set([...into.linkedProperties.map(String), ...from.linkedProperties.map(String), ...(from.propertyId ? [String(from.propertyId)] : [])])].filter((x) => x !== String(into.propertyId)).slice(0, 10);
  common.entry(into, 'merged', user._id, { from: from.leadNo });
  from.mergedInto = into._id;
  from.stage = 'closed_lost'; from.lostReason = 'duplicate'; from.closedAt = new Date();
  common.entry(from, 'merged_into', user._id, { into: into.leadNo });
  await SiteVisit.updateMany({ leadId: from._id }, { $set: { leadId: into._id } });
  await FollowUp.updateMany({ leadId: from._id }, { $set: { leadId: into._id } });
  await Offer.updateMany({ leadId: from._id }, { $set: { leadId: into._id } });
  await from.save(); await into.save();
  await audit(req, { action: 'lead.merge', entityType: 'Lead', entityId: into._id, after: { from: from.leadNo } });
  return agentSvc.leadRow(into.toObject());
}

async function queue(user) {
  const s = await scope(user);
  const now = new Date();
  const staleSince = new Date(now.getTime() - (await settings.get('lead.staleDays')) * 86400000);
  const [unassigned, breached, requests, stale, load] = await Promise.all([
    Lead.find({ ...s, assignedTo: null, stage: { $in: common.OPEN_STAGES }, mergedInto: null }).sort({ createdAt: 1 }).limit(50).lean(),
    Lead.find({ ...s, stage: 'new', firstContactAt: null, slaDueAt: { $lt: now } }).sort({ slaDueAt: 1 }).limit(50).populate('assignedTo', 'name').lean(),
    Lead.find({ ...s, 'reassignRequests.status': 'open' }).limit(50).populate('assignedTo', 'name').lean(),
    Lead.find({ ...s, stage: { $in: common.OPEN_STAGES }, lastActivityAt: { $lt: staleSince } }).sort({ lastActivityAt: 1 }).limit(50).populate('assignedTo', 'name').lean(),
    Lead.aggregate([{ $match: { ...s, stage: { $in: common.OPEN_STAGES }, assignedTo: { $ne: null } } }, { $group: { _id: '$assignedTo', open: { $sum: 1 }, breached: { $sum: { $cond: [{ $ne: ['$slaBreachedAt', null] }, 1, 0] } } } }]),
  ]);
  const agents = await User.find({ _id: { $in: load.map((l) => l._id) } }).select('name').lean();
  const names = Object.fromEntries(agents.map((a) => [String(a._id), a.name]));
  const row = (l) => ({ ...agentSvc.leadRow(l), agent: l.assignedTo && l.assignedTo.name });
  return {
    unassigned: await agentSvc.attachProperties(unassigned.map(row)),
    breached: await agentSvc.attachProperties(breached.map(row)),
    reassignRequests: requests.map((l) => ({ ...row(l), requests: l.reassignRequests.filter((r) => r.status === 'open') })),
    stale: await agentSvc.attachProperties(stale.map(row)),
    agentLoad: load.map((l) => ({ agentId: l._id, name: names[String(l._id)], open: l.open, breached: l.breached })).sort((a, b) => b.open - a.open),
  };
}

async function decideRequest(user, id, reqId, body, req) {
  const d = z.object({ decision: z.enum(['approve', 'reject']), agentId: oid.optional(), note: z.string().trim().max(300).optional() }).parse(body);
  const lead = await scopedLead(user, id);
  const r = lead.reassignRequests.id(reqId);
  if (!r || r.status !== 'open') throw ApiError.notFound('Open request not found');
  Object.assign(r, { status: d.decision === 'approve' ? 'approved' : 'rejected', decidedBy: user._id, decidedAt: new Date(), note: d.note });
  if (d.decision === 'approve') {
    if (!d.agentId) throw ApiError.validation([{ in: 'body', path: 'agentId', message: 'Choose the new agent' }]);
    await assignOne(user, lead, d.agentId, `Reassignment request: ${r.reason}`);
  } else await lead.save();
  await audit(req, { action: `lead.reassign_${d.decision}`, entityType: 'Lead', entityId: lead._id, reason: d.note });
  return agentSvc.leadRow(lead.toObject());
}

// CSV export; contacts only with contacts.view (RE-B-10).
async function exportCsv(user, query, res) {
  const filter = { ...(await scope(user)), mergedInto: null };
  if (query.stage) filter.stage = { $in: String(query.stage).split(',') };
  if (query.from || query.to) filter.createdAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  const withContacts = reveal.isAdmin(user);
  const rows = await Lead.find(filter).sort({ createdAt: -1 }).limit(20000).populate('assignedTo', 'name').populate('teamId', 'name').lean();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['leadNo', 'createdAt', 'stage', 'priority', 'source', 'buyerName', ...(withContacts ? ['buyerPhone', 'buyerEmail'] : []), 'propertyId', 'agent', 'team', 'slaDueAt', 'firstContactAt', 'slaBreached', 'lostReason', 'referralCode', 'utmSource', 'utmCampaign'];
  const lines = rows.map((l) => [l.leadNo, l.createdAt && l.createdAt.toISOString(), l.stage, l.priority, (l.sources || [])[0], l.buyer.name, ...(withContacts ? [l.buyer.phone, l.buyer.email] : []), l.propertyId, l.assignedTo && l.assignedTo.name, l.teamId && l.teamId.name, l.slaDueAt && l.slaDueAt.toISOString(), l.firstContactAt && l.firstContactAt.toISOString(), l.slaBreachedAt ? 'yes' : 'no', l.lostReason, l.referralCode, l.utm && l.utm.source, l.utm && l.utm.campaign].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send([header.join(','), ...lines].join('\n'));
}

async function visits(user, query) {
  const filter = {};
  if (query.from || query.to) filter.scheduledAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.agentId) filter.agentId = query.agentId;
  if (user.role === 'manager') {
    const { Team } = require('../teams/models');
    const teams = await Team.find({ managerIds: user._id }).lean();
    const scoped = teams.flatMap((t) => t.members.map((m) => String(m.agentId)));
    // A manager's agent filter narrows inside the team scope; an agent outside it matches nothing.
    filter.agentId = query.agentId ? (scoped.includes(String(query.agentId)) ? query.agentId : null) : { $in: scoped };
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, parseInt(query.limit, 10) || 50);
  const [items, total] = await Promise.all([
    SiteVisit.find(filter).sort({ scheduledAt: query.sort === 'oldest' ? 1 : -1 }).skip((page - 1) * limit).limit(limit).populate('agentId', 'name').populate('propertyId', 'listingNo title location.locality').populate('leadId', 'leadNo buyer.name').lean(),
    SiteVisit.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function patchVisit(user, id, body, req) {
  const d = z.object({ agentId: oid.optional(), cancelReason: z.string().trim().min(3).max(300).optional() }).parse(body);
  const v = await SiteVisit.findById(id);
  if (!v) throw ApiError.notFound('Visit not found');
  await scopedLead(user, v.leadId);
  if (d.agentId) { await assertAssignable(user, d.agentId); v.agentId = d.agentId; }
  if (d.cancelReason) {
    if (!['requested', 'scheduled', 'confirmed'].includes(v.status)) throw ApiError.conflict(`This visit is ${v.status}`, 'INVALID_TRANSITION');
    v.status = 'cancelled'; v.cancelReason = d.cancelReason;
  }
  await v.save();
  await audit(req, { action: 'visit.admin_update', entityType: 'SiteVisit', entityId: v._id, after: d });
  return v;
}

async function addNote(user, id, body) {
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(body);
  const lead = await scopedLead(user, id);
  common.entry(lead, 'note', user._id, { text, by: 'admin' });
  lead.lastActivityAt = new Date();
  await lead.save();
  return { ok: true };
}

module.exports = { list, detail, assign, bulkAssign, reopen, recycle, merge, queue, decideRequest, exportCsv, visits, patchVisit, scope, addNote };
