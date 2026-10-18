// Shared lead helpers: working-hours SLA (C3), routing + assignment (C2),
// timeline entries, "Buyer N" labels and the stage rules from spec 4.3.
const { Lead } = require('./models');
const { User } = require('../auth/models');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { notifyUser, notifyPermission } = require('../notifications/service');

const OPEN_STAGES = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation', 'booking'];
const STAGE_ORDER = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation', 'booking', 'closed_won'];
const SIMPLE_STAGE = { // buyer tracker (RE-C-18)
  new: 'Received', contacted: 'In touch', qualified: 'In touch', site_visit_scheduled: 'Visit scheduled', site_visit_done: 'Visited',
  negotiation: 'Negotiating', booking: 'Booked', closed_won: 'Booked', closed_lost: 'Closed',
};

const IST = 330 * 60000;
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

function parseHours(team, s) {
  if (team && team.workingHours) return team.workingHours;
  const [range] = String(s['calendar.workingHours'] || '09:00-20:00').split(' ');
  const [start, end] = range.split('-');
  return { start, end, days: [1, 2, 3, 4, 5, 6] };
}

// Adds `hours` of working time (team hours, IST, holidays excluded) to `from`.
function addWorkingHours(from, hours, wh, holidays = []) {
  let remaining = hours * 60;
  let t = new Date(from.getTime() + IST); // shifted clock: UTC fields read as IST
  const start = hm(wh.start || '09:00');
  const end = hm(wh.end || '20:00');
  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    const day = t.toISOString().slice(0, 10);
    const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
    const workDay = (wh.days || [1, 2, 3, 4, 5, 6]).includes(t.getUTCDay()) && !holidays.includes(day);
    if (!workDay || minutes >= end) { t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1, 0, 0)); t.setUTCMinutes(start); continue; }
    if (minutes < start) { t.setUTCHours(0, start, 0, 0); continue; }
    const use = Math.min(remaining, end - minutes);
    t = new Date(t.getTime() + use * 60000);
    remaining -= use;
  }
  return new Date(t.getTime() - IST);
}

async function slaDue(from, team) {
  const s = await settings.all();
  return addWorkingHours(from, s['lead.firstContactSlaHours'], parseHours(team, s), s['calendar.holidays'] || []);
}

function entry(lead, type, by, data) {
  lead.timeline.push({ type, by, at: new Date(), data });
  if (lead.timeline.length > 500) lead.timeline.splice(0, lead.timeline.length - 500);
  lead.lastActivityAt = new Date();
}

async function nextBuyerLabel(propertyId) {
  if (!propertyId) return undefined;
  const n = await Lead.countDocuments({ $or: [{ propertyId }, { projectId: propertyId }] });
  return `Buyer ${n + 1}`;
}

// Route and assign (workflow C2). Writes assignedTo/teamId/slaDueAt and notifies.
async function route(lead, ctx) {
  const teams = require('../teams/service');
  const { Team } = require('../teams/models');
  if (lead.throttled || lead.otpUnverified) {
    lead.slaDueAt = await slaDue(new Date(), null);
    await notifyPermission('leads.assign', 'lead.unassigned', { leadNo: lead.leadNo, leadId: String(lead._id), reason: lead.throttled ? 'throttled seeker' : 'unverified phone' });
    return null;
  }
  const { teamId, mode } = await teams.teamFor(ctx);
  if (!teamId) {
    lead.slaDueAt = await slaDue(new Date(), null);
    await notifyPermission('leads.assign', 'lead.unassigned', { leadNo: lead.leadNo, leadId: String(lead._id), reason: 'no matching team' });
    return null;
  }
  const pick = await teams.pickAgent(teamId, { buyerContactId: lead.buyer.contactId, mode });
  const team = pick && pick.team ? pick.team : await Team.findById(teamId);
  lead.teamId = teamId;
  if (!pick || !pick.agentId) {
    lead.slaDueAt = await slaDue(new Date(), team);
    if (team) await teams.notifyCapacityFull(team);
    return null;
  }
  await assign(lead, pick.agentId, null, { team, note: pick.sticky ? 'Same buyer, same agent' : 'Auto-routed' });
  return pick.agentId;
}

async function assign(lead, agentId, by, { team, note, notifyOld = true } = {}) {
  const old = lead.assignedTo;
  lead.assignedTo = agentId;
  lead.assignedAt = new Date();
  if (team) lead.teamId = team._id;
  if (lead.stage === 'new' && !lead.firstContactAt) lead.slaDueAt = await slaDue(new Date(), team);
  entry(lead, old ? 'reassigned' : 'assigned', by, { from: old, to: agentId, note });
  const agent = await User.findById(agentId);
  if (agent) await notifyUser({ user: agent, event: old ? 'lead.reassigned' : 'lead.assigned', channels: ['in_app', 'email'], vars: { leadNo: lead.leadNo, leadId: String(lead._id), dueAt: lead.slaDueAt ? lead.slaDueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '' } });
  if (old && notifyOld && String(old) !== String(agentId)) {
    const prev = await User.findById(old);
    if (prev) await notifyUser({ user: prev, event: 'lead.reassigned', vars: { leadNo: lead.leadNo, leadId: String(lead._id), dueAt: '' } });
  }
}

// Stage rules (spec 4.3 "Rules on transitions").
async function changeStage(lead, to, by, { note, lostReason, lostNote, system = false } = {}) {
  const from = lead.stage;
  if (from === to) return lead;
  if (!OPEN_STAGES.includes(from) && !system) throw ApiError.conflict(`A ${from.replace('_', ' ')} lead cannot change stage here`, 'INVALID_TRANSITION');
  if (to === 'closed_won' && !system) throw ApiError.validation([{ in: 'body', path: 'stage', message: 'A lead is won only when its deal is verified' }]);
  if (to === 'booking' && !system) throw ApiError.validation([{ in: 'body', path: 'stage', message: 'Booking starts when a deal is submitted' }]);
  if (to === 'site_visit_done' && !system) {
    const { SiteVisit } = require('./models');
    if (!(await SiteVisit.exists({ leadId: lead._id, status: 'completed' }))) throw ApiError.validation([{ in: 'body', path: 'stage', message: 'Record a completed site visit first' }]);
  }
  if (to === 'closed_lost') {
    if (!lostReason) throw ApiError.validation([{ in: 'body', path: 'lostReason', message: 'A lost reason is required' }]);
    const min = await settings.get('lead.minAttemptsBeforeLost');
    if (lostReason === 'not_responding' && (lead.callAttempts || 0) < min) throw ApiError.validation([{ in: 'body', path: 'lostReason', message: `Log at least ${min} call attempts before marking "not responding"` }]);
    lead.previousStage = from;
    lead.lostReason = lostReason;
    lead.lostNote = lostNote;
    lead.closedAt = new Date();
    const { FollowUp } = require('./models');
    await FollowUp.updateMany({ leadId: lead._id, status: 'open' }, { $set: { status: 'cancelled' } });
  } else if (!system && STAGE_ORDER.indexOf(to) < STAGE_ORDER.indexOf(from)) {
    if (!['contacted', 'qualified'].includes(to)) throw ApiError.validation([{ in: 'body', path: 'stage', message: 'You can only move back to contacted or qualified' }]);
    if (!note) throw ApiError.validation([{ in: 'body', path: 'note', message: 'Add a note when moving a lead back' }]);
  }
  if (from === 'new' && !lead.firstContactAt) lead.firstContactAt = new Date(); // SLA stops
  lead.stage = to;
  if (to === 'closed_won') lead.closedAt = new Date();
  entry(lead, 'stage', by, { from, to, note, lostReason });
  // Central lead desk: the platform status of the lead (deal wins convert there via deal.closed).
  if (!(system && to === 'closed_won')) await require('./hub').updated(lead, { platformStatus: to.slice(0, 40), ...(lostReason ? { note: `Lost: ${lostReason}` } : {}) });
  return lead;
}

// Optional ?from=&to= query dates as a Mongo range (inclusive; a date-only "to"
// covers that whole day). 422 on an unreadable date; null when neither is set.
function dateRange(query) {
  const out = {};
  for (const [k, op] of [['from', '$gte'], ['to', '$lte']]) {
    if (!query || !query[k]) continue;
    const raw = String(query[k]);
    let d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw ApiError.validation([{ in: 'query', path: k, message: 'Use a valid date' }]);
    if (k === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) d = new Date(d.getTime() + 86400000 - 1);
    out[op] = d;
  }
  return Object.keys(out).length ? out : null;
}

async function leadOr404(id, extra = {}) {
  const lead = await Lead.findOne({ _id: id, ...extra });
  if (!lead) throw ApiError.notFound('Lead not found');
  return lead;
}

module.exports = { OPEN_STAGES, STAGE_ORDER, SIMPLE_STAGE, addWorkingHours, slaDue, entry, nextBuyerLabel, route, assign, changeStage, leadOr404, parseHours, dateRange };
