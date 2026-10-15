// Module O - reports (RE-O-01..04), exports (RE-O-07), dashboards, agent KPIs
// (RE-O-03), lister stats (RE-O-08), nightly snapshots and the lead-data
// retention job (RE-O-09). Managers get team-scoped numbers. Reports run as
// aggregation pipelines on read; the nightly snapshot keeps daily KPIs for trends.
const { z } = require('zod');
const { Lead, SiteVisit, Offer, BuyerContact } = require('../leads/models');
const { Property } = require('../listings/models');
const { Project } = require('../projects/models');
const { Deal } = require('../deals/models');
const { Receivable } = require('../receivables/models');
const { User } = require('../auth/models');
const { Team } = require('../teams/models');
const { PropertyView, ListingReport, Shortlist } = require('../search/models');
const { ExportJob, ReportSnapshot } = require('./models');
const { Outbox } = require('../../core/outbox');
const storage = require('../../core/storage');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser, notifyPermission } = require('../notifications/service');
const reveal = require('../masking/reveal.service');
const receivables = require('../receivables/service');
const leadCommon = require('../leads/common');

const DAY = 86400000;
const LIVE_MAX_ROWS = 10000;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const rupees = (paise) => Math.round(paise || 0) / 100;

// ---------------------------------------------------------------- scope and range

const rangeSchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

function range(query) {
  const d = rangeSchema.parse({ from: query.from || undefined, to: query.to || undefined });
  const to = d.to || new Date();
  const from = d.from || new Date(to.getTime() - 30 * DAY);
  if (from > to) throw ApiError.validation([{ in: 'query', path: 'from', message: 'From must be before to' }]);
  if (to - from > 731 * DAY) throw ApiError.validation([{ in: 'query', path: 'from', message: 'Pick a range of at most 2 years' }]);
  return { from, to };
}

async function teamScope(user) {
  if (user.role !== 'manager') return null;
  return reveal.managedTeamIds(user);
}

async function agentIdsFor(teams) {
  const rows = await Team.find(teams ? { _id: { $in: teams } } : {}).select('members.agentId').lean();
  return [...new Set(rows.flatMap((t) => (t.members || []).map((m) => String(m.agentId))))];
}

// ---------------------------------------------------------------- reports

async function listingsReport(user, r) {
  const created = { createdAt: { $gte: r.from, $lte: r.to }, deletedAt: null };
  const [byStatus, byCity, byType, turnaround] = await Promise.all([
    Property.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Property.aggregate([{ $match: created }, { $group: { _id: '$location.city', count: { $sum: 1 }, live: { $sum: { $cond: [{ $eq: ['$status', 'live'] }, 1, 0] } } } }, { $sort: { count: -1 } }]),
    Property.aggregate([{ $match: created }, { $group: { _id: { purpose: '$purpose', type: '$type' }, count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Property.aggregate([{ $match: { liveAt: { $gte: r.from, $lte: r.to }, submittedAt: { $ne: null } } }, { $project: { h: { $divide: [{ $subtract: ['$liveAt', '$submittedAt'] }, 3600000] } } }, { $group: { _id: null, avgHours: { $avg: '$h' }, maxHours: { $max: '$h' }, n: { $sum: 1 } } }]),
  ]);
  const t = turnaround[0] || { avgHours: 0, maxHours: 0, n: 0 };
  return {
    summary: { approved: t.n, avgApprovalHours: Math.round(t.avgHours * 10) / 10, maxApprovalHours: Math.round(t.maxHours * 10) / 10, slaHours: await settings.get('listing.reviewSlaHours').catch(() => 24) },
    byStatus: byStatus.map((x) => ({ status: x._id, count: x.count })),
    byCity: byCity.map((x) => ({ city: x._id || 'Unknown', count: x.count, live: x.live })),
    byType: byType.map((x) => ({ purpose: x._id.purpose, type: x._id.type, count: x.count })),
    rows: byCity.map((x) => ({ city: x._id || 'Unknown', listings: x.count, live: x.live })),
  };
}

async function leadMatch(user, r) {
  const teams = await teamScope(user);
  return { createdAt: { $gte: r.from, $lte: r.to }, mergedInto: null, ...(teams ? { teamId: { $in: teams } } : {}) };
}

async function leadsReport(user, r) {
  const match = await leadMatch(user, r);
  const [bySource, byStage, byTeam, byCity, total] = await Promise.all([
    Lead.aggregate([{ $match: match }, { $unwind: '$sources' }, { $group: { _id: '$sources', count: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ['$stage', 'closed_won'] }, 1, 0] } } } }, { $sort: { count: -1 } }]),
    Lead.aggregate([{ $match: match }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
    Lead.aggregate([{ $match: match }, { $group: { _id: '$teamId', count: { $sum: 1 } } }, { $lookup: { from: 'teams', localField: '_id', foreignField: '_id', as: 't' } }]),
    Lead.aggregate([{ $match: match }, { $group: { _id: '$requirement.city', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Lead.countDocuments(match),
  ]);
  return {
    summary: { total },
    bySource: bySource.map((x) => ({ source: x._id, count: x.count, won: x.won, conversion: pct(x.won, x.count) })),
    byStage: byStage.map((x) => ({ stage: x._id, count: x.count })),
    byTeam: byTeam.map((x) => ({ team: (x.t[0] && x.t[0].name) || 'Unassigned', count: x.count })),
    byCity: byCity.map((x) => ({ city: x._id || 'Unknown', count: x.count })),
    rows: bySource.map((x) => ({ source: x._id, leads: x.count, won: x.won, conversion: pct(x.won, x.count) })),
  };
}

// Funnel: leads that reached each stage at least once in the period (from the stage timeline).
async function funnelReport(user, r) {
  const match = await leadMatch(user, r);
  const leads = await Lead.find(match).select('stage timeline.type timeline.data.to').lean();
  const order = leadCommon.STAGE_ORDER;
  const reached = Object.fromEntries(order.map((s) => [s, 0]));
  for (const l of leads) {
    const seen = new Set(['new', l.stage, ...(l.timeline || []).filter((t) => t.type === 'stage' && t.data).map((t) => t.data.to)]);
    let max = -1;
    seen.forEach((s) => { const i = order.indexOf(s); if (i > max) max = i; });
    for (let i = 0; i <= max; i += 1) reached[order[i]] += 1;
  }
  const lost = leads.filter((l) => l.stage === 'closed_lost').length;
  const rows = order.map((s, i) => ({ stage: s, leads: reached[s], ofPrevious: i ? pct(reached[s], reached[order[i - 1]]) : 100 }));
  return { summary: { total: leads.length, lost, won: reached.closed_won, conversion: pct(reached.closed_won, leads.length) }, rows };
}

async function slaReport(user, r) {
  const match = { ...(await leadMatch(user, r)), slaDueAt: { $ne: null } };
  const rows = await Lead.aggregate([
    { $match: match },
    { $project: { assignedTo: 1, met: { $cond: [{ $and: [{ $ne: ['$firstContactAt', null] }, { $lte: ['$firstContactAt', '$slaDueAt'] }] }, 1, 0] }, breached: { $cond: [{ $ne: ['$slaBreachedAt', null] }, 1, 0] }, mins: { $cond: [{ $ne: ['$firstContactAt', null] }, { $divide: [{ $subtract: ['$firstContactAt', '$assignedAt'] }, 60000] }, null] } } },
    { $group: { _id: '$assignedTo', leads: { $sum: 1 }, met: { $sum: '$met' }, breached: { $sum: '$breached' }, avgMins: { $avg: '$mins' } } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
    { $sort: { leads: -1 } },
  ]);
  const out = rows.map((x) => ({ agent: (x.u[0] && x.u[0].name) || 'Unassigned', agentId: x._id, leads: x.leads, slaMet: x.met, slaMetPercent: pct(x.met, x.leads), breached: x.breached, avgFirstContactMinutes: x.avgMins === null ? null : Math.round(x.avgMins) }));
  const tot = out.reduce((a, x) => ({ leads: a.leads + x.leads, met: a.met + x.slaMet }), { leads: 0, met: 0 });
  return { summary: { leads: tot.leads, slaMetPercent: pct(tot.met, tot.leads) }, rows: out };
}

// Agent performance (RE-O-03): conversion % = verified deals / leads assigned in the period (acceptance 2).
async function agentStats(agentIds, r) {
  const ids = agentIds.map((x) => (typeof x === 'string' ? require('mongoose').Types.ObjectId.createFromHexString(x) : x));
  const inRange = { $gte: r.from, $lte: r.to };
  const [assigned, visits, deals] = await Promise.all([
    Lead.aggregate([{ $match: { assignedTo: { $in: ids }, assignedAt: inRange } }, { $group: { _id: '$assignedTo', leads: { $sum: 1 }, contacted: { $sum: { $cond: [{ $ne: ['$firstContactAt', null] }, 1, 0] } }, slaMet: { $sum: { $cond: [{ $and: [{ $ne: ['$firstContactAt', null] }, { $ne: ['$slaDueAt', null] }, { $lte: ['$firstContactAt', '$slaDueAt'] }] }, 1, 0] } }, withSla: { $sum: { $cond: [{ $ne: ['$slaDueAt', null] }, 1, 0] } } } }]),
    SiteVisit.aggregate([{ $match: { agentId: { $in: ids }, scheduledAt: inRange } }, { $group: { _id: '$agentId', scheduled: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } } } }]),
    Deal.aggregate([{ $match: { agentId: { $in: ids }, $or: [{ 'review.verifiedAt': inRange }, { submittedAt: inRange }] } }, { $group: { _id: '$agentId', submitted: { $sum: { $cond: [{ $and: [{ $gte: ['$submittedAt', r.from] }, { $lte: ['$submittedAt', r.to] }] }, 1, 0] } }, verified: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'verified'] }, { $gte: ['$review.verifiedAt', r.from] }, { $lte: ['$review.verifiedAt', r.to] }] }, 1, 0] } }, commission: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'verified'] }, { $gte: ['$review.verifiedAt', r.from] }] }, '$commissionAmount', 0] } } } }]),
  ]);
  const by = (rows, id) => rows.find((x) => String(x._id) === String(id)) || {};
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  return ids.map((id) => {
    const a = by(assigned, id); const v = by(visits, id); const d = by(deals, id);
    const u = users.find((x) => String(x._id) === String(id));
    return {
      agentId: id, agent: u ? u.name : '', leadsAssigned: a.leads || 0, contacted: a.contacted || 0, slaMetPercent: pct(a.slaMet || 0, a.withSla || 0),
      visitsScheduled: v.scheduled || 0, visitsCompleted: v.completed || 0, dealsSubmitted: d.submitted || 0, dealsVerified: d.verified || 0,
      conversionPercent: pct(d.verified || 0, a.leads || 0), commission: d.commission || 0,
    };
  });
}

async function agentsReport(user, r) {
  const teams = await teamScope(user);
  const ids = teams ? await agentIdsFor(teams) : (await User.find({ role: 'agent' }).select('_id').lean()).map((u) => String(u._id));
  const rows = (await agentStats(ids, r)).sort((a, b) => b.dealsVerified - a.dealsVerified || b.leadsAssigned - a.leadsAssigned);
  const sum = (k) => rows.reduce((a, x) => a + x[k], 0);
  return { summary: { agents: rows.length, leadsAssigned: sum('leadsAssigned'), dealsVerified: sum('dealsVerified'), conversionPercent: pct(sum('dealsVerified'), sum('leadsAssigned')), commission: sum('commission') }, rows };
}

// Commission (RE-O-04): earned (verified), invoiced, received by month, plus outstanding and ageing.
async function commissionReport(user, r) {
  const teams = await teamScope(user);
  const scope = teams ? { teamId: { $in: teams } } : {};
  const month = (field) => ({ $dateToString: { format: '%Y-%m', date: field, timezone: 'Asia/Kolkata' } });
  const [earned, invoiced, received, open] = await Promise.all([
    Deal.aggregate([{ $match: { ...scope, status: 'verified', 'review.verifiedAt': { $gte: r.from, $lte: r.to } } }, { $group: { _id: month('$review.verifiedAt'), deals: { $sum: 1 }, commission: { $sum: '$commissionAmount' }, gst: { $sum: '$gstAmount' } } }]),
    Receivable.aggregate([{ $match: scope }, { $unwind: '$invoices' }, { $match: { 'invoices.status': 'issued', 'invoices.date': { $gte: r.from, $lte: r.to } } }, { $group: { _id: month('$invoices.date'), invoiced: { $sum: '$invoices.total' } } }]),
    Receivable.aggregate([{ $match: scope }, { $unwind: '$payments' }, { $match: { 'payments.status': 'confirmed', 'payments.confirmedAt': { $gte: r.from, $lte: r.to } } }, { $group: { _id: month('$payments.confirmedAt'), received: { $sum: '$payments.amount' }, tds: { $sum: '$payments.tds' } } }]),
    Receivable.find({ ...scope, status: { $in: [...receivables.OPEN, 'disputed'] } }).select('totalDue receivedAmount tdsAmount writtenOffAmount').lean(),
  ]);
  const months = [...new Set([...earned, ...invoiced, ...received].map((x) => x._id))].sort();
  const f = (rows, m, k) => ((rows.find((x) => x._id === m) || {})[k] || 0);
  const rows = months.map((m) => ({ month: m, deals: f(earned, m, 'deals'), commission: f(earned, m, 'commission'), gst: f(earned, m, 'gst'), invoiced: f(invoiced, m, 'invoiced'), received: f(received, m, 'received'), tds: f(received, m, 'tds') }));
  const outstanding = open.reduce((a, x) => a + receivables.outstanding(x), 0);
  return { summary: { commission: rows.reduce((a, x) => a + x.commission, 0), invoiced: rows.reduce((a, x) => a + x.invoiced, 0), received: rows.reduce((a, x) => a + x.received, 0), outstanding }, ageing: await receivables.ageing(user), rows };
}

async function ageingReport(user) {
  const a = await receivables.ageing(user);
  return { summary: { total: a.total, uninvoiced: a.uninvoiced, disputed: a.disputed }, rows: Object.keys(a.buckets).map((b) => ({ bucket: b, amount: a.buckets[b], receivables: a.counts[b] })) };
}

const REPORTS = { listings: listingsReport, leads: leadsReport, funnel: funnelReport, sla: slaReport, agents: agentsReport, commission: commissionReport, ageing: ageingReport };
const MONEY_COLS = new Set(['commission', 'gst', 'invoiced', 'received', 'tds', 'amount']);

async function run(user, key, query) {
  const fn = REPORTS[key];
  if (!fn) throw ApiError.notFound(`Unknown report "${key}". Available: ${Object.keys(REPORTS).join(', ')}`);
  const r = range(query);
  return { key, from: r.from, to: r.to, ...(await fn(user, r, query)) };
}

// ---------------------------------------------------------------- exports (RE-O-07)

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]).filter((k) => k !== 'agentId');
  const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(MONEY_COLS.has(c) ? rupees(r[c]) : r[c])).join(','))].join('\n');
}

async function exportCsv(user, key, query, res, req) {
  const data = await run(user, key, query);
  if (data.rows.length > LIVE_MAX_ROWS || query.async === 'true') {
    const job = await ExportJob.create({ requestedBy: user._id, kind: `report:${key}`, filters: { ...query }, status: 'queued' });
    await require('../../core/jobs').enqueue('reports.export', { exportId: String(job._id) });
    await audit(req, { action: 'report.export', entityType: 'ExportJob', entityId: job._id, after: { key, async: true } });
    return res.status(202).json({ success: true, data: { exportId: job._id, status: job.status } });
  }
  await audit(req, { action: 'report.export', entityType: 'Report', after: { key, rows: data.rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${key}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(toCsv(data.rows));
}

// Job: build the CSV, store it privately, notify with a link valid 24 h.
async function runExport({ exportId }) {
  const job = await ExportJob.findById(exportId);
  if (!job || job.status !== 'queued') return;
  job.status = 'running';
  await job.save();
  try {
    const user = await User.findById(job.requestedBy);
    const key = job.kind.replace(/^report:/, '');
    const data = await run(user, key, job.filters || {});
    const csv = toCsv(data.rows);
    const file = await storage.save({ buffer: Buffer.from(csv, 'utf8'), originalname: `${key}.csv`, mimetype: 'text/csv' }, { ownerId: user._id, purpose: 'data_export' });
    Object.assign(job, { status: 'ready', fileId: file._id, rows: data.rows.length, expiresAt: new Date(Date.now() + DAY) });
    await job.save();
    await notifyUser({ user, event: 'export.ready', vars: { kind: key, rows: data.rows.length, link: `/admin/exports/${job._id}` }, channels: ['in_app', 'email'] });
  } catch (err) {
    Object.assign(job, { status: 'failed', error: String(err.message).slice(0, 500) });
    await job.save();
  }
}

async function download(user, id, req) {
  const job = await ExportJob.findById(id);
  if (!job || (String(job.requestedBy) !== String(user._id) && user.role !== 'superadmin')) throw ApiError.notFound('Export not found');
  if (job.status !== 'ready') return { status: job.status, error: job.error };
  if (job.expiresAt < new Date()) throw ApiError.conflict('This export link has expired; run the export again', 'EXPORT_EXPIRED');
  const file = await storage.FileModel.findById(job.fileId);
  await audit(req, { action: 'export.download', entityType: 'ExportJob', entityId: job._id });
  return { status: 'ready', rows: job.rows, url: storage.urlFor(file, 600), expiresAt: job.expiresAt };
}

async function expireExports(now = new Date()) {
  const old = await ExportJob.find({ status: 'ready', expiresAt: { $lt: now } });
  for (const j of old) {
    const f = j.fileId && await storage.FileModel.findById(j.fileId);
    if (f) await storage.remove(f).catch(() => {});
    j.status = 'expired';
    await j.save();
  }
  return old.length;
}

// ---------------------------------------------------------------- dashboards

// IST calendar month and Indian financial year (1 April) starts, as UTC instants.
function periodStarts(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const at = (yy, mm) => new Date(Date.UTC(yy, mm, 1) - 330 * 60000);
  return { month: at(y, m), fy: at(m >= 3 ? y : y - 1, 3) };
}

// Tiles added for RE-S-ADM-01: paused listings (all scope only), offers awaiting
// the owner, verified commission this month / FY, overdue invoices and deals
// waiting for verification longer than deal.verifySlaHours. `t` is the team
// filter ({} for admins); offers have no team so they go by the team's agents.
async function dashboardExtras(teams, t, now = new Date()) {
  const { month, fy } = periodStarts(now);
  const slaHours = await settings.get('deal.verifySlaHours');
  const agentIds = teams ? await agentIdsFor(teams) : null;
  const verified = (from) => Deal.aggregate([
    { $match: { ...t, status: 'verified', 'review.verifiedAt': { $gte: from, $lte: now } } },
    { $group: { _id: null, deals: { $sum: 1 }, commission: { $sum: '$commissionAmount' }, gst: { $sum: '$gstAmount' } } },
  ]);
  const [paused, offers, beyondSla, monthRows, fyRows, overdueRecs] = await Promise.all([
    teams ? null : Property.countDocuments({ status: 'paused', deletedAt: null }),
    Offer.countDocuments({ status: 'awaiting_lister', ...(agentIds ? { agentId: { $in: agentIds } } : {}) }),
    Deal.countDocuments({ ...t, status: { $in: ['submitted', 'under_review'] }, submittedAt: { $lt: new Date(now.getTime() - slaHours * 3600000) } }),
    verified(month),
    verified(fy),
    Receivable.find({ ...t, status: { $in: receivables.COLLECTING }, invoices: { $elemMatch: { status: 'issued', dueDate: { $lt: now } } } }).select('invoices.status invoices.dueDate invoices.total receivedAmount tdsAmount writtenOffAmount status').lean(),
  ]);
  const sum = (rows) => ({ deals: (rows[0] && rows[0].deals) || 0, commission: (rows[0] && rows[0].commission) || 0, gst: (rows[0] && rows[0].gst) || 0 });
  const invoicesOverdue = overdueRecs.reduce((a, r) => {
    const issued = (r.invoices || []).filter((i) => i.status === 'issued');
    const due = issued.reduce((s, i) => s + (i.total || 0), 0) - (r.receivedAmount || 0) - (r.tdsAmount || 0) - (r.writtenOffAmount || 0);
    if (due <= 0) return a;
    return { count: a.count + issued.filter((i) => i.dueDate && new Date(i.dueDate) < now).length, amount: a.amount + due };
  }, { count: 0, amount: 0 });
  return {
    pausedListings: paused,
    offersAwaitingOwner: offers,
    dealsBeyondSla: beyondSla,
    slaHours,
    commission: { month: { from: month, ...sum(monthRows) }, financialYear: { from: fy, ...sum(fyRows) } },
    invoicesOverdue,
  };
}

async function adminDashboard(user) {
  const teams = await teamScope(user);
  const t = teams ? { teamId: { $in: teams } } : {};
  const start = new Date(new Date(Date.now() + 330 * 60000).setUTCHours(0, 0, 0, 0) - 330 * 60000);
  const end = new Date(start.getTime() + DAY);
  const { VerificationSession } = require('../listings/models');
  const [leadsToday, unassigned, breached, visitsToday, dealsWaiting, openRecs, overdue, approvals, projects, photoQa, reports, outboxPending, outboxDead] = await Promise.all([
    Lead.countDocuments({ ...t, createdAt: { $gte: start, $lt: end } }),
    teams ? Lead.countDocuments({ ...t, assignedTo: null, stage: 'new' }) : Lead.countDocuments({ assignedTo: null, stage: 'new' }),
    Lead.countDocuments({ ...t, stage: 'new', slaBreachedAt: { $ne: null } }),
    SiteVisit.countDocuments({ scheduledAt: { $gte: start, $lt: end }, status: { $in: ['scheduled', 'confirmed', 'completed'] }, ...(teams ? { agentId: { $in: await agentIdsFor(teams) } } : {}) }),
    Deal.countDocuments({ ...t, status: { $in: ['submitted', 'under_review'] } }),
    Receivable.find({ ...t, status: { $in: [...receivables.OPEN, 'disputed'] } }).select('status totalDue receivedAmount tdsAmount writtenOffAmount').lean(),
    Receivable.countDocuments({ ...t, status: 'overdue' }),
    teams ? null : Property.countDocuments({ status: 'pending_approval' }),
    teams ? null : Project.countDocuments({ status: 'pending_approval' }),
    teams || !VerificationSession ? null : VerificationSession.countDocuments({ status: 'pending_review' }),
    teams ? null : ListingReport.countDocuments({ status: 'open' }),
    teams ? null : Outbox.countDocuments({ status: 'pending' }),
    teams ? null : Outbox.countDocuments({ status: 'dead' }),
  ]);
  const extra = await dashboardExtras(teams, t);
  const trend = await ReportSnapshot.find({ key: 'daily_kpis', 'scope.teamId': null }).sort({ day: -1 }).limit(30).lean();
  return {
    leads: { today: leadsToday, unassigned, slaBreached: breached },
    visits: { today: visitsToday },
    deals: { awaitingVerification: dealsWaiting, beyondSla: extra.dealsBeyondSla, slaHours: extra.slaHours },
    offers: { awaitingOwner: extra.offersAwaitingOwner },
    commission: extra.commission,
    receivables: { open: openRecs.length, outstanding: openRecs.reduce((a, x) => a + receivables.outstanding(x), 0), overdue, invoicesOverdue: extra.invoicesOverdue },
    listings: teams ? null : { paused: extra.pausedListings },
    queues: teams ? null : { listings: approvals, projects, photoVerification: photoQa, reportedListings: reports },
    integrations: teams ? null : { outboxPending, outboxDead },
    trend: trend.reverse().map((x) => ({ day: x.day, ...x.data })),
    scope: teams ? 'team' : 'all',
  };
}

async function agentPerformance(user, query) {
  const r = range(query);
  const [mine] = await agentStats([user._id], r);
  const followUpsDue = await require('../leads/models').FollowUp.countDocuments({ agentId: user._id, status: 'open', dueAt: { $lt: new Date() } });
  const open = await Lead.countDocuments({ assignedTo: user._id, stage: { $in: leadCommon.OPEN_STAGES } });
  return { from: r.from, to: r.to, ...mine, openLeads: open, overdueFollowUps: followUpsDue };
}

// ---------------------------------------------------------------- lister (RE-O-08)

async function listerDashboard(user) {
  const props = await Property.find({ listerId: user._id, deletedAt: null }).select('status stats verification expiresAt listingNo title').lean();
  const ids = props.map((p) => p._id);
  const byStatus = props.reduce((a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }), {});
  const sum = (k) => props.reduce((a, p) => a + ((p.stats && p.stats[k]) || 0), 0);
  const soon = new Date(Date.now() + 7 * DAY);
  const [openLeads, upcomingVisits, offersWaiting, invoices] = await Promise.all([
    Lead.countDocuments({ propertyId: { $in: ids }, stage: { $in: leadCommon.OPEN_STAGES } }),
    SiteVisit.countDocuments({ propertyId: { $in: ids }, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $gte: new Date() } }),
    Offer.countDocuments({ listerId: user._id, status: 'awaiting_lister' }),
    receivables.listerInvoices(user, {}),
  ]);
  return {
    listings: { total: props.length, byStatus, expiringSoon: props.filter((p) => p.status === 'live' && p.expiresAt && p.expiresAt < soon).map((p) => ({ _id: p._id, listingNo: p.listingNo, title: p.title, expiresAt: p.expiresAt })) },
    totals: { views: sum('views'), shortlists: sum('shortlists'), enquiries: sum('enquiries'), whatsappClicks: sum('whatsappClicks') },
    leads: { open: openLeads }, visits: { upcoming: upcomingVisits }, offers: { awaitingYou: offersWaiting },
    badges: { photoVerified: props.filter((p) => p.verification && p.verification.photo && p.verification.photo.status === 'verified').length, siteVerified: props.filter((p) => p.verification && p.verification.site && p.verification.site.status === 'verified').length },
    invoices: invoices.summary,
  };
}

async function listingStats(user, id, query) {
  const p = await Property.findOne({ _id: id, listerId: user._id, deletedAt: null }).select('listingNo title status stats price purpose location.localityId details.areaSqft liveAt').lean();
  if (!p) throw ApiError.notFound('Listing not found');
  const r = range(query);
  const fromDay = r.from.toISOString().slice(0, 10);
  const toDay = r.to.toISOString().slice(0, 10);
  const inRange = { $gte: r.from, $lte: r.to };
  const [views, stages, visits, offers, feedback, rEnquiries, rVisitRequests, rVisitsDone, rOffers, rShortlists] = await Promise.all([
    PropertyView.aggregate([{ $match: { propertyId: p._id, day: { $gte: fromDay, $lte: toDay } } }, { $group: { _id: '$day', views: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Lead.aggregate([{ $match: { propertyId: p._id, mergedInto: null } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]),
    SiteVisit.countDocuments({ propertyId: p._id, status: 'completed' }),
    Offer.countDocuments({ propertyId: p._id }),
    SiteVisit.find({ propertyId: p._id, 'feedback.interest': { $ne: null } }).select('feedback.interest').lean(),
    // Counters for the chosen range (dated collections only).
    Lead.countDocuments({ propertyId: p._id, mergedInto: null, createdAt: inRange }),
    SiteVisit.countDocuments({ propertyId: p._id, createdAt: inRange }),
    SiteVisit.countDocuments({ propertyId: p._id, status: 'completed', scheduledAt: inRange }),
    Offer.countDocuments({ propertyId: p._id, createdAt: inRange }),
    Shortlist.countDocuments({ propertyId: p._id, createdAt: inRange }),
  ]);
  // Locality comparison (RE-E-17): average live price per sqft in the same locality and purpose.
  const peers = await Property.aggregate([{ $match: { status: 'live', purpose: p.purpose, 'location.localityId': p.location && p.location.localityId, _id: { $ne: p._id } } }, { $group: { _id: null, ppsf: { $avg: '$price.pricePerSqft' }, views: { $avg: '$stats.views' }, n: { $sum: 1 } } }]);
  const peer = peers[0];
  return {
    listingNo: p.listingNo, title: p.title, status: p.status, from: r.from, to: r.to,
    // counters: lifetime totals since the listing went live; rangeCounters: the chosen from..to.
    rangeCounters: { views: views.reduce((a, x) => a + x.views, 0), enquiries: rEnquiries, visits: rVisitRequests, visitsDone: rVisitsDone, offersReceived: rOffers, shortlists: rShortlists },
    counters: { ...(p.stats || {}), visitsDone: visits, offersReceived: offers, avgInterest: feedback.length >= 3 ? Math.round((feedback.reduce((a, x) => a + x.feedback.interest, 0) / feedback.length) * 10) / 10 : null },
    viewsPerDay: views.map((x) => ({ day: x._id, views: x.views })),
    funnel: leadCommon.STAGE_ORDER.concat('closed_lost').map((s) => ({ stage: s, count: (stages.find((x) => x._id === s) || {}).count || 0 })),
    locality: peer && peer.n >= 3 ? { listings: peer.n, avgPricePerSqft: Math.round(peer.ppsf), yourPricePerSqft: p.price && p.price.pricePerSqft, avgViews: Math.round(peer.views) } : null,
  };
}

// ---------------------------------------------------------------- nightly snapshot and retention

async function snapshot(now = new Date()) {
  const day = new Date(now.getTime() + 330 * 60000 - DAY).toISOString().slice(0, 10); // yesterday (IST)
  const from = new Date(`${day}T00:00:00+05:30`);
  const to = new Date(from.getTime() + DAY);
  try {
    const [leads, visits, verified, commission] = await Promise.all([
      Lead.countDocuments({ createdAt: { $gte: from, $lt: to } }),
      SiteVisit.countDocuments({ status: 'completed', scheduledAt: { $gte: from, $lt: to } }),
      Deal.countDocuments({ status: 'verified', 'review.verifiedAt': { $gte: from, $lt: to } }),
      Deal.aggregate([{ $match: { status: 'verified', 'review.verifiedAt': { $gte: from, $lt: to } } }, { $group: { _id: null, c: { $sum: '$commissionAmount' } } }]),
    ]);
    await ReportSnapshot.updateOne({ key: 'daily_kpis', day, 'scope.teamId': null }, { $set: { data: { leads, visits, dealsVerified: verified, commission: (commission[0] && commission[0].c) || 0 } } }, { upsert: true });
    return { day };
  } catch (err) {
    await notifyPermission('integrations.manage', 'snapshot.failed', { error: String(err.message).slice(0, 200) });
    throw err;
  }
}

const ANON = 'Buyer anonymised';

// RE-O-09: closed_lost (or merged) leads closed more than N months ago and not linked to any deal.
async function runRetention({ now = new Date(), dryRun = false } = {}) {
  const months = await settings.get('retention.leadAnonymiseMonths');
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  const candidates = await Lead.find({ anonymisedAt: null, $or: [{ stage: 'closed_lost', closedAt: { $lt: cutoff } }, { mergedInto: { $ne: null }, updatedAt: { $lt: cutoff } }] }).select('_id leadNo buyer propertyId').lean();
  const withDeal = new Set((await Deal.find({ leadId: { $in: candidates.map((l) => l._id) } }).select('leadId').lean()).map((d) => String(d.leadId)));
  const targets = candidates.filter((l) => !withDeal.has(String(l._id)));
  if (dryRun) return { dryRun: true, leads: targets.length, list: targets.slice(0, 200).map((l) => l.leadNo) };
  let contacts = 0;
  for (const l of targets) {
    await Lead.updateOne({ _id: l._id }, {
      $set: { 'buyer.name': ANON, 'buyer.phone': null, 'buyer.email': null, 'requirement.notes': null, lostNote: null, anonymisedAt: now, 'timeline.$[].data.message': null, 'timeline.$[].data.note': null },
    });
    await SiteVisit.updateMany({ leadId: l._id }, { $unset: { 'feedback.comments': 1, 'outcome.feedback': 1 } });
    // The contact record goes too when it has no other open or recent lead.
    if (l.buyer && l.buyer.contactId) {
      const other = await Lead.exists({ 'buyer.contactId': l.buyer.contactId, _id: { $ne: l._id }, $or: [{ stage: { $in: leadCommon.OPEN_STAGES } }, { updatedAt: { $gte: cutoff } }] });
      if (!other && BuyerContact) {
        await BuyerContact.updateOne({ _id: l.buyer.contactId }, { $set: { name: ANON, email: null, phone: `anon:${l.buyer.contactId}` } });
        contacts += 1;
      }
    }
  }
  await audit(null, { action: 'retention.run', entityType: 'Lead', after: { leadsAnonymised: targets.length, contactsAnonymised: contacts, cutoff } });
  return { dryRun: false, leads: targets.length, contacts };
}

module.exports = {
  REPORTS, run, exportCsv, runExport, download, expireExports, adminDashboard, agentPerformance, listerDashboard, listingStats,
  snapshot, runRetention, range, toCsv,
};
