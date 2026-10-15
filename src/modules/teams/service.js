// Module J - Teams & Territory Management (spec 4.10) and the assignment
// engine used by lead routing (Module C workflow C2): ordered routing rules ->
// team -> round-robin (atomic pointer) or least open leads, honouring
// availability, leave, working hours, capacity and the sticky-buyer rule.
const { z } = require('zod');
const { Team, RoutingRule } = require('./models');
const { User } = require('../auth/models');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser } = require('../notifications/service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const OPEN_STAGES = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation', 'booking'];

const teamSchema = z.object({
  name: z.string().trim().min(2).max(60),
  managerIds: z.array(oid).max(10).default([]),
  members: z.array(z.object({ agentId: oid, capacity: z.number().int().min(1).max(500).default(50), available: z.boolean().default(true) })).max(100).default([]),
  territories: z.object({ cities: z.array(z.string().max(60)).default([]), localities: z.array(z.string().max(60)).default([]) }).default({}),
  workingHours: z.object({ start: HHMM.default('09:00'), end: HHMM.default('20:00'), days: z.array(z.number().int().min(0).max(6)).min(1).default([1, 2, 3, 4, 5, 6]) }).default({}),
  mode: z.enum(['round_robin', 'least_open_leads']).default('round_robin'),
  active: z.boolean().default(true),
});

async function openLeadCounts(agentIds) {
  const { Lead } = require('../leads/models');
  const rows = await Lead.aggregate([{ $match: { assignedTo: { $in: agentIds }, stage: { $in: OPEN_STAGES } } }, { $group: { _id: '$assignedTo', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
}

async function listTeams(user) {
  const filter = user.role === 'manager' ? { managerIds: user._id } : {};
  const teams = await Team.find(filter).sort({ name: 1 }).populate('managerIds', 'name email').populate('members.agentId', 'name email status').lean();
  const counts = await openLeadCounts(teams.flatMap((t) => t.members.map((m) => m.agentId && m.agentId._id)).filter(Boolean));
  return teams.map((t) => ({ ...t, members: t.members.map((m) => ({ ...m, openLeads: (m.agentId && counts[String(m.agentId._id)]) || 0 })) }));
}

async function assertStaff(ids, role) {
  if (!ids.length) return;
  const n = await User.countDocuments({ _id: { $in: ids }, role: Array.isArray(role) ? { $in: role } : role, status: 'active' });
  if (n !== new Set(ids.map(String)).size) throw ApiError.validation([{ in: 'body', path: role === 'manager' ? 'managerIds' : 'members', message: `Every id must be an active ${Array.isArray(role) ? role.join(' / ') : role}` }]);
}

// An agent belongs to exactly one team.
async function assertSingleTeam(agentIds, exceptTeamId) {
  const clash = await Team.findOne({ _id: { $ne: exceptTeamId }, 'members.agentId': { $in: agentIds } }).select('name').lean();
  if (clash) throw ApiError.conflict(`An agent is already in team "${clash.name}"`, 'AGENT_IN_OTHER_TEAM');
}

async function createTeam(body, req) {
  const d = teamSchema.parse(body);
  await assertStaff(d.managerIds, ['manager', 'admin', 'superadmin']);
  await assertStaff(d.members.map((m) => m.agentId), ['agent', 'manager']);
  await assertSingleTeam(d.members.map((m) => m.agentId));
  if (await Team.exists({ name: d.name })) throw ApiError.conflict('A team with this name exists', 'DUPLICATE');
  const t = await Team.create(d);
  await audit(req, { action: 'team.create', entityType: 'Team', entityId: t._id });
  return t;
}

async function editTeam(id, body, req) {
  const d = teamSchema.partial().parse(body);
  const t = await Team.findById(id);
  if (!t) throw ApiError.notFound('Team not found');
  if (d.managerIds) await assertStaff(d.managerIds, ['manager', 'admin', 'superadmin']);
  if (d.members) {
    await assertStaff(d.members.map((m) => m.agentId), ['agent', 'manager']);
    await assertSingleTeam(d.members.map((m) => m.agentId), t._id);
    // keep lastAssignedAt / leave for existing members
    d.members = d.members.map((m) => { const old = t.members.find((x) => String(x.agentId) === m.agentId); return old ? { ...old.toObject(), ...m } : m; });
  }
  Object.assign(t, d);
  await t.save();
  await audit(req, { action: 'team.edit', entityType: 'Team', entityId: t._id });
  return t;
}

async function deleteTeam(id, req) {
  const { Lead } = require('../leads/models');
  if (await Lead.exists({ teamId: id, stage: { $in: OPEN_STAGES } })) throw ApiError.conflict('Reassign the open leads of this team first', 'TEAM_HAS_OPEN_LEADS');
  if (await RoutingRule.exists({ teamId: id, active: true })) throw ApiError.conflict('Routing rules still point to this team', 'TEAM_IN_RULES');
  const r = await Team.deleteOne({ _id: id });
  if (!r.deletedCount) throw ApiError.notFound('Team not found');
  await audit(req, { action: 'team.delete', entityType: 'Team', entityId: id });
  return { deleted: true };
}

async function patchMember(teamId, agentId, body, user, req) {
  const d = z.object({ capacity: z.number().int().min(1).max(500).optional(), available: z.boolean().optional(), leaveFrom: z.coerce.date().nullable().optional(), leaveTo: z.coerce.date().nullable().optional() }).parse(body);
  const t = await Team.findById(teamId);
  if (!t) throw ApiError.notFound('Team not found');
  if (user.role === 'manager' && !t.managerIds.some((m) => String(m) === String(user._id))) throw ApiError.forbidden('You do not manage this team', 'OUT_OF_SCOPE');
  const m = t.members.find((x) => String(x.agentId) === String(agentId));
  if (!m) throw ApiError.notFound('Agent is not in this team');
  Object.assign(m, d);
  await t.save();
  await audit(req, { action: 'team.member', entityType: 'Team', entityId: t._id, after: { agentId, ...d } });
  return m;
}

// Agent self-service: away toggle and leave dates (RE-J-05).
async function setOwnAvailability(user, body, req) {
  const d = z.object({ available: z.boolean().optional(), leaveFrom: z.coerce.date().nullable().optional(), leaveTo: z.coerce.date().nullable().optional() }).parse(body);
  if (d.leaveFrom && d.leaveTo && d.leaveTo < d.leaveFrom) throw ApiError.validation([{ in: 'body', path: 'leaveTo', message: 'Leave end must be after the start' }]);
  const t = await Team.findOne({ 'members.agentId': user._id });
  if (!t) throw ApiError.conflict('You are not in a team yet', 'NO_TEAM');
  const m = t.members.find((x) => String(x.agentId) === String(user._id));
  Object.assign(m, d);
  await t.save();
  await audit(req, { action: 'agent.availability', entityType: 'Team', entityId: t._id, after: d });
  return { team: t.name, available: m.available, leaveFrom: m.leaveFrom, leaveTo: m.leaveTo, capacity: m.capacity };
}

async function myTeam(user) {
  const t = await Team.findOne({ 'members.agentId': user._id }).lean();
  if (!t) return null;
  const m = t.members.find((x) => String(x.agentId) === String(user._id));
  return { teamId: t._id, team: t.name, ...m, workingHours: t.workingHours };
}

// ---------------------------------------------------------------- routing rules

const ruleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  active: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).optional(),
  conditions: z.object({
    cities: z.array(z.string()).default([]), localities: z.array(z.string()).default([]), purpose: z.enum(['sale', 'rent']).optional(),
    category: z.enum(['residential', 'commercial', 'land']).optional(), types: z.array(z.string()).default([]),
    budgetMin: z.number().min(0).optional(), budgetMax: z.number().min(0).optional(), sources: z.array(z.string()).default([]), listerTypes: z.array(z.string()).default([]),
  }).default({}),
  teamId: oid,
  modeOverride: z.enum(['round_robin', 'least_open_leads']).optional(),
});

const listRules = () => RoutingRule.find().sort({ priority: 1 }).populate('teamId', 'name').lean();

async function createRule(body, req) {
  const d = ruleSchema.parse(body);
  if (!(await Team.exists({ _id: d.teamId }))) throw ApiError.validation([{ in: 'body', path: 'teamId', message: 'Unknown team' }]);
  if (d.priority === undefined) { const last = await RoutingRule.findOne().sort({ priority: -1 }).lean(); d.priority = last ? last.priority + 10 : 10; }
  const r = await RoutingRule.create(d);
  await audit(req, { action: 'routing.create', entityType: 'RoutingRule', entityId: r._id });
  return r;
}

async function editRule(id, body, req) {
  const d = ruleSchema.partial().parse(body);
  const r = await RoutingRule.findByIdAndUpdate(id, { $set: d }, { new: true });
  if (!r) throw ApiError.notFound('Rule not found');
  await audit(req, { action: 'routing.edit', entityType: 'RoutingRule', entityId: r._id });
  return r;
}

async function deleteRule(id, req) {
  const r = await RoutingRule.deleteOne({ _id: id });
  if (!r.deletedCount) throw ApiError.notFound('Rule not found');
  await audit(req, { action: 'routing.delete', entityType: 'RoutingRule', entityId: id });
  return { deleted: true };
}

async function reorderRules(body, req) {
  const { ids } = z.object({ ids: z.array(oid).min(1) }).parse(body);
  await Promise.all(ids.map((id, i) => RoutingRule.updateOne({ _id: id }, { $set: { priority: (i + 1) * 10 } })));
  await audit(req, { action: 'routing.reorder', entityType: 'RoutingRule', after: ids });
  return listRules();
}

// ctx: { city, locality, purpose, category, type, budget (rupees), source, listerType }
function ruleMatches(rule, ctx) {
  const c = rule.conditions || {};
  const inList = (list, v) => !list || !list.length || (v !== undefined && list.map((x) => String(x).toLowerCase()).includes(String(v).toLowerCase()));
  if (!inList(c.cities, ctx.city)) return false;
  if (c.localities && c.localities.length && !(ctx.localities || [ctx.locality]).some((l) => inList(c.localities, l))) return false;
  if (c.purpose && c.purpose !== ctx.purpose) return false;
  if (c.category && c.category !== ctx.category) return false;
  if (!inList(c.types, ctx.type)) return false;
  if (!inList(c.sources, ctx.source)) return false;
  if (!inList(c.listerTypes, ctx.listerType)) return false;
  if (c.budgetMin !== undefined && !(ctx.budget >= c.budgetMin)) return false;
  if (c.budgetMax !== undefined && !(ctx.budget <= c.budgetMax)) return false;
  return true;
}

async function teamFor(ctx) {
  const rules = await RoutingRule.find({ active: true }).sort({ priority: 1 }).lean();
  const rule = rules.find((r) => ruleMatches(r, ctx));
  if (rule) return { teamId: rule.teamId, rule, mode: rule.modeOverride };
  const def = await settings.get('routing.defaultTeamId');
  return def ? { teamId: def, rule: null } : { teamId: null, rule: null };
}

function withinHours(team, now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  const day = ist.getUTCDay();
  const hm = `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
  const wh = team.workingHours || {};
  return (wh.days || [1, 2, 3, 4, 5, 6]).includes(day) && hm >= (wh.start || '09:00') && hm < (wh.end || '20:00');
}

async function candidates(team, now = new Date()) {
  const s = await settings.all();
  if (!s['routing.allowOffHoursAssign'] && !withinHours(team, now)) return [];
  const ids = team.members.map((m) => m.agentId);
  const active = new Set((await User.find({ _id: { $in: ids }, status: 'active', role: { $in: ['agent', 'manager'] } }).distinct('_id')).map(String));
  const counts = await openLeadCounts(ids);
  return team.members.filter((m) => active.has(String(m.agentId)) && m.available !== false
    && !(m.leaveFrom && m.leaveTo && now >= m.leaveFrom && now <= m.leaveTo)
    && (counts[String(m.agentId)] || 0) < (m.capacity || s['routing.agentCapacity']))
    .map((m) => ({ ...m.toObject ? m.toObject() : m, openLeads: counts[String(m.agentId)] || 0 }));
}

// Picks an agent in the team; returns null when nobody is available.
async function pickAgent(teamId, { buyerContactId, mode, excludeAgentId } = {}) {
  const team = await Team.findOne({ _id: teamId, active: true });
  if (!team) return null;
  let pool = await candidates(team);
  if (excludeAgentId) pool = pool.filter((m) => String(m.agentId) !== String(excludeAgentId));
  if (!pool.length) return { team, agentId: null };
  if (buyerContactId && await settings.get('routing.stickyBuyer')) {
    const { Lead } = require('../leads/models');
    const other = await Lead.findOne({ 'buyer.contactId': buyerContactId, teamId: team._id, stage: { $in: OPEN_STAGES }, assignedTo: { $in: pool.map((m) => m.agentId) } }).select('assignedTo').lean();
    if (other) return { team, agentId: other.assignedTo, sticky: true };
  }
  const how = mode || team.mode || 'round_robin';
  let chosen;
  if (how === 'least_open_leads') {
    chosen = [...pool].sort((a, b) => a.openLeads - b.openLeads || new Date(a.lastAssignedAt || 0) - new Date(b.lastAssignedAt || 0))[0];
  } else {
    // Atomic pointer: concurrent leads get distinct positions.
    const t = await Team.findOneAndUpdate({ _id: team._id }, { $inc: { pointer: 1 } }, { new: false });
    const order = team.members.map((m) => String(m.agentId));
    const eligible = new Set(pool.map((m) => String(m.agentId)));
    for (let i = 0; i < order.length; i += 1) {
      const id = order[(t.pointer + i) % order.length];
      if (eligible.has(id)) { chosen = pool.find((m) => String(m.agentId) === id); break; }
    }
  }
  await Team.updateOne({ _id: team._id, 'members.agentId': chosen.agentId }, { $set: { 'members.$.lastAssignedAt': new Date() } });
  return { team, agentId: chosen.agentId };
}

// Admin simulator: which team and agent would get a lead like this?
async function simulate(body) {
  const ctx = z.object({ city: z.string().optional(), locality: z.string().optional(), purpose: z.string().optional(), category: z.string().optional(), type: z.string().optional(), budget: z.number().optional(), source: z.string().optional(), listerType: z.string().optional() }).parse(body);
  const { teamId, rule } = await teamFor(ctx);
  if (!teamId) return { rule: null, team: null, agents: [], note: 'No rule matches and no default team: the lead goes to the manager queue' };
  const team = await Team.findById(teamId).populate('members.agentId', 'name').lean();
  const pool = await candidates(await Team.findById(teamId));
  return {
    rule: rule ? { id: rule._id, name: rule.name, priority: rule.priority } : { name: 'Default team' },
    team: team && { id: team._id, name: team.name, mode: (rule && rule.modeOverride) || team.mode },
    agents: pool.map((m) => ({ agentId: m.agentId, name: ((team.members.find((x) => String(x.agentId._id) === String(m.agentId)) || {}).agentId || {}).name, openLeads: m.openLeads, capacity: m.capacity })),
  };
}

async function notifyCapacityFull(team) {
  const managers = await User.find({ _id: { $in: team.managerIds } });
  for (const m of managers) await notifyUser({ user: m, event: 'team.capacity_full', vars: { team: team.name } });
}

module.exports = {
  listTeams, createTeam, editTeam, deleteTeam, patchMember, setOwnAvailability, myTeam,
  listRules, createRule, editRule, deleteRule, reorderRules, simulate, ruleMatches, teamFor, pickAgent, candidates, withinHours, notifyCapacityFull, OPEN_STAGES,
};
