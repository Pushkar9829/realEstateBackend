// Module C background work (workflows C3, C4, C6, C7): first-contact SLA,
// unassigned escalation, stale leads, visit reminders and feedback requests,
// offer reminders and expiry, auto-close on sold properties.
const { Lead, SiteVisit, Offer, FollowUp } = require('./models');
const { User } = require('../auth/models');
const settings = require('../../core/settings');
const env = require('../../config/env');
const { notifyUser, notifyPermission, sendNow } = require('../notifications/service');
const common = require('./common');

async function managersOf(teamId) {
  if (!teamId) return [];
  const { Team } = require('../teams/models');
  const t = await Team.findById(teamId).lean();
  return t ? User.find({ _id: { $in: t.managerIds }, status: 'active' }) : [];
}

// C3 steps 2-3: breach at slaDueAt, escalate at 2x.
async function slaSweep(now = new Date()) {
  const s = await settings.all();
  let breached = 0;
  const due = await Lead.find({ stage: 'new', firstContactAt: null, slaDueAt: { $lt: now }, slaBreachedAt: null, assignedTo: { $ne: null } }).limit(500);
  for (const lead of due) {
    lead.slaBreachedAt = now;
    lead.slaBreachCount = (lead.slaBreachCount || 0) + 1;
    common.entry(lead, 'sla_breached', null, { dueAt: lead.slaDueAt });
    await lead.save();
    for (const m of await managersOf(lead.teamId)) await notifyUser({ user: m, event: 'lead.sla_breached', channels: ['in_app', 'email'], vars: { leadNo: lead.leadNo, leadId: String(lead._id) } });
    breached += 1;
  }
  // 2x: from assignment, twice the SLA window has passed without contact.
  const twice = await Lead.find({ stage: 'new', firstContactAt: null, slaBreachedAt: { $ne: null }, slaBreachCount: 1, assignedAt: { $ne: null } }).limit(500);
  for (const lead of twice) {
    const window = lead.slaDueAt.getTime() - lead.assignedAt.getTime();
    if (now.getTime() < lead.slaDueAt.getTime() + window) continue;
    lead.slaBreachCount = 2;
    await notifyPermission('leads.assign', 'lead.sla_breached_2x', { leadNo: lead.leadNo, leadId: String(lead._id) }, ['in_app', 'email']);
    if (s['lead.autoReassignOnBreach'] && lead.teamId) {
      const pick = await require('../teams/service').pickAgent(lead.teamId, { excludeAgentId: lead.assignedTo });
      if (pick && pick.agentId) await common.assign(lead, pick.agentId, null, { team: pick.team, note: 'Auto-reassigned after 2x SLA' });
    }
    await lead.save();
  }
  return breached;
}

// Unassigned leads waiting longer than lead.unassignedEscalationMinutes.
async function unassignedEscalation(now = new Date()) {
  const mins = await settings.get('lead.unassignedEscalationMinutes');
  const rows = await Lead.find({ assignedTo: null, stage: 'new', mergedInto: null, createdAt: { $lt: new Date(now.getTime() - mins * 60000) }, 'timeline.type': { $ne: 'unassigned_escalated' } }).limit(200);
  for (const lead of rows) {
    common.entry(lead, 'unassigned_escalated', null, {});
    await lead.save();
    await notifyPermission('leads.assign', 'lead.unassigned', { leadNo: lead.leadNo, leadId: String(lead._id), reason: `waiting more than ${mins} minutes` });
  }
  return rows.length;
}

// Daily digest of stale leads per manager.
async function staleDigest(now = new Date()) {
  const days = await settings.get('lead.staleDays');
  const rows = await Lead.find({ stage: { $in: common.OPEN_STAGES }, lastActivityAt: { $lt: new Date(now.getTime() - days * 86400000) }, teamId: { $ne: null } }).select('leadNo teamId').lean();
  const byTeam = rows.reduce((a, l) => { (a[String(l.teamId)] = a[String(l.teamId)] || []).push(l.leadNo); return a; }, {});
  for (const [teamId, list] of Object.entries(byTeam)) {
    for (const m of await managersOf(teamId)) await notifyUser({ user: m, event: 'lead.stale', vars: { count: list.length, list: list.slice(0, 20).join(', ') } });
  }
  return rows.length;
}

// Close open leads whose property sold to someone else, untouched for N days.
async function autoCloseSold(now = new Date()) {
  const { Property } = require('../listings/models');
  const days = await settings.get('lead.autoCloseOnSoldDays');
  const sold = await Property.find({ status: { $in: ['sold', 'rented', 'inactive'] }, updatedAt: { $lt: new Date(now.getTime() - days * 86400000) } }).distinct('_id');
  const leads = await Lead.find({ propertyId: { $in: sold }, stage: { $in: ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation'] }, lastActivityAt: { $lt: new Date(now.getTime() - days * 86400000) } }).limit(500);
  for (const lead of leads) {
    await common.changeStage(lead, 'closed_lost', null, { lostReason: 'property_sold', lostNote: 'Property no longer available', system: true });
    await lead.save();
  }
  return leads.length;
}

async function visitReminder({ visitId, kind, scheduledAt }) {
  const v = await SiteVisit.findById(visitId).populate('propertyId', 'listingNo title listerId');
  if (!v || !['scheduled', 'confirmed'].includes(v.status)) return 'skipped';
  if (new Date(scheduledAt).getTime() !== v.scheduledAt.getTime()) return 'rescheduled'; // stale reminder
  const when = v.scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const vars = { visitNo: v.visitNo, when, listingNo: v.propertyId.listingNo, meetingPoint: v.meetingPoint || 'At the property' };
  const lead = await Lead.findById(v.leadId);
  if (kind.startsWith('buyer') && lead) {
    if (lead.buyer.userId) { const u = await User.findById(lead.buyer.userId); if (u) await notifyUser({ user: u, event: 'sitevisit.reminder', channels: ['sms', 'in_app'], vars }); } else await sendNow({ channel: 'sms', to: lead.buyer.phone, event: 'sitevisit.reminder', vars, fallbackEmail: lead.buyer.email }).catch(() => {});
  } else if (kind === 'agent1' && v.agentId) {
    const a = await User.findById(v.agentId); if (a) await notifyUser({ user: a, event: 'sitevisit.reminder', vars });
  } else if (kind === 'lister24') {
    const l = await User.findById(v.propertyId.listerId); if (l) await notifyUser({ user: l, event: 'sitevisit.reminder', vars: { ...vars, meetingPoint: '' } });
  }
  v.remindersSent = [...(v.remindersSent || []), kind];
  await v.save();
  return 'sent';
}

async function feedbackRequest({ visitId, token }) {
  const v = await SiteVisit.findById(visitId).populate('propertyId', 'listingNo');
  if (!v || v.status !== 'completed' || (v.feedback && v.feedback.submittedAt)) return 'skipped';
  const lead = await Lead.findById(v.leadId);
  const vars = { visitNo: v.visitNo, listingNo: v.propertyId.listingNo, link: `${env.CLIENT_URL}/visit-feedback/${token}` };
  if (lead.buyer.userId) { const u = await User.findById(lead.buyer.userId); if (u) await notifyUser({ user: u, event: 'sitevisit.feedback_request', channels: ['email', 'sms', 'in_app'], vars }); } else await sendNow({ channel: 'sms', to: lead.buyer.phone, event: 'sitevisit.feedback_request', vars, fallbackEmail: lead.buyer.email }).catch(() => {});
  v.feedback.sentAt = new Date();
  v.markModified('feedback');
  await v.save();
  return 'sent';
}

// Offers: lister reminder after offer.reminderHours; expire at validUntil.
async function offerSweep(now = new Date()) {
  const hours = await settings.get('offer.reminderHours');
  const remind = await Offer.find({ status: 'awaiting_lister', updatedAt: { $lt: new Date(now.getTime() - hours * 3600000) }, validUntil: { $gt: now }, 'rounds.note': { $ne: '__reminded' } }).limit(200);
  for (const o of remind) {
    const lister = await User.findById(o.listerId);
    if (lister) await notifyUser({ user: lister, event: 'offer.reminder', channels: ['in_app', 'sms'], vars: { offerNo: o.offerNo, buyerLabel: o.buyerLabel } });
    o.updatedAt = now; // reminder once per window
    await o.save();
  }
  const expired = await Offer.find({ status: { $in: ['awaiting_lister', 'awaiting_buyer'] }, validUntil: { $lt: now } }).limit(500);
  for (const o of expired) {
    o.status = 'expired';
    await o.save();
    for (const id of [o.agentId, o.listerId]) { const u = await User.findById(id); if (u) await notifyUser({ user: u, event: 'offer.closed', vars: { offerNo: o.offerNo, status: 'expired' } }); }
    const lead = await Lead.findById(o.leadId);
    if (lead) { common.entry(lead, 'offer', null, { offerNo: o.offerNo, kind: 'expired' }); await lead.save(); }
  }
  return { reminded: remind.length, expired: expired.length };
}

async function followupReminder({ followUpId }) {
  const f = await FollowUp.findById(followUpId).populate('leadId', 'leadNo');
  if (!f || f.status !== 'open') return 'skipped';
  const a = await User.findById(f.agentId);
  if (a) await notifyUser({ user: a, event: 'followup.due', vars: { leadNo: f.leadId && f.leadId.leadNo, type: f.type, when: f.dueAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) } });
  return 'sent';
}

// Buyer-requested visits not scheduled within 24 h: tell the manager.
async function requestedVisitsFlag(now = new Date()) {
  const rows = await SiteVisit.find({ status: 'requested', createdAt: { $lt: new Date(now.getTime() - 86400000) }, remindersSent: { $ne: 'requested_flag' } }).limit(200);
  for (const v of rows) {
    const lead = await Lead.findById(v.leadId).select('teamId leadNo').lean();
    for (const m of await managersOf(lead && lead.teamId)) await notifyUser({ user: m, event: 'sitevisit.requested_waiting', vars: { visitNo: v.visitNo, leadNo: lead.leadNo } });
    v.remindersSent = [...(v.remindersSent || []), 'requested_flag'];
    await v.save();
  }
  return rows.length;
}

function register() {
  const jobs = require('../../core/jobs');
  const { daily } = require('../../core/schedule');
  jobs.register('sitevisit.reminder', visitReminder);
  jobs.register('sitevisit.feedback_request', feedbackRequest);
  jobs.register('followup.reminder', followupReminder);
  jobs.every('leads.sla', 5 * 60 * 1000, () => slaSweep());
  jobs.every('leads.unassigned', 5 * 60 * 1000, () => unassignedEscalation());
  jobs.every('leads.offers', 15 * 60 * 1000, () => offerSweep());
  jobs.every('leads.requested_visits', 60 * 60 * 1000, () => requestedVisitsFlag());
  daily('leads.stale', { hour: 9 }, () => staleDigest());
  daily('leads.autoclose', { hour: 2 }, () => autoCloseSold());
}

module.exports = { register, slaSweep, unassignedEscalation, staleDigest, autoCloseSold, visitReminder, feedbackRequest, offerSweep, followupReminder, requestedVisitsFlag };
