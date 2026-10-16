// Daily RERA validity job (registered in projects/index.js via core/schedule):
//  - RE-L-10 / Workflow L2 step 4: super admins are told 30 and 7 days before
//    a platform agent registration (`rera.agentRegistrations` validTill) ends.
//  - RE-G-08 step 5: builder projects whose RERA registration validTill is
//    within 30 days or past are flagged (`reraExpiry`), the builder and the
//    project reviewers (projects.approve) are told, and the project's linked
//    listings get the `rera_expired` warning once it has passed.
const { Project } = require('./models');
const { Property } = require('../listings/models');
const { User } = require('../auth/models');
const settings = require('../../core/settings');
const { istParts } = require('../../core/schedule');
const { notifyUser, notifyPermission } = require('../notifications/service');

const AGENT_REMINDER_DAYS = [30, 7];
const PROJECT_WARN_DAYS = 30;
const PROJECT_STATUSES = ['live', 'sold_out', 'pending_approval', 'changes_requested'];
const fmtDate = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

// Whole IST calendar days from `now` to `date` (0 = today, negative = past).
function daysUntil(date, now = new Date()) {
  const a = Date.parse(istParts(now).day);
  const b = Date.parse(istParts(new Date(date)).day);
  return Math.round((b - a) / 86400000);
}

async function agentRegistrations(now) {
  const rows = (await settings.get('rera.agentRegistrations')) || [];
  const due = (Array.isArray(rows) ? rows : []).filter((r) => r && r.validTill && !Number.isNaN(Date.parse(r.validTill)) && AGENT_REMINDER_DAYS.includes(daysUntil(r.validTill, now)));
  if (!due.length) return 0;
  const admins = await User.find({ role: 'superadmin', status: 'active' });
  for (const r of due) {
    for (const a of admins) {
      await notifyUser({ user: a, event: 'rera.agent_registration_expiring', channels: ['in_app', 'email'], vars: { state: r.state || '-', number: r.number || '-', date: fmtDate(r.validTill), days: daysUntil(r.validTill, now) } });
    }
  }
  return due.length;
}

async function projectRegistrations(now) {
  const out = { expiring: 0, expired: 0, cleared: 0 };
  const projects = await Project.find({ status: { $in: PROJECT_STATUSES }, 'rera.registrations.validTill': { $type: 'date' } });
  for (const p of projects) {
    const regs = (p.rera.registrations || []).filter((r) => r.validTill).sort((a, b) => a.validTill - b.validTill);
    if (!regs.length) continue;
    const r = regs[0];
    const days = daysUntil(r.validTill, now);
    const prev = (p.reraExpiry && p.reraExpiry.status) || 'ok';
    const status = days <= 0 ? 'expired' : days <= PROJECT_WARN_DAYS ? 'expiring' : 'ok';
    if (status === 'ok') {
      if (prev !== 'ok') { p.reraExpiry = { status: 'ok' }; await p.save(); out.cleared += 1; }
      continue;
    }
    const changed = prev !== status || (p.reraExpiry && p.reraExpiry.number !== r.number);
    if (changed) {
      p.reraExpiry = { status, number: r.number, validTill: r.validTill, flaggedAt: now };
      await p.save();
    }
    if (status === 'expired' && changed) {
      await Property.updateMany({ projectId: p._id, deletedAt: null }, { $addToSet: { warnings: 'rera_expired' } });
    }
    // Tell everyone when the flag changes, and again 7 days before the end.
    if (!changed && !(status === 'expiring' && days === 7)) continue;
    const when = status === 'expired' ? `ended on ${fmtDate(r.validTill)}` : `ends on ${fmtDate(r.validTill)} (in ${days} days)`;
    const vars = { projectNo: p.projectNo, name: p.name, number: r.number, state: r.state, when, projectId: String(p._id) };
    const builder = await User.findById(p.builderId);
    if (builder) await notifyUser({ user: builder, event: 'project.rera_expiring', channels: ['in_app', 'email'], vars: { ...vars, link: `/lister/projects/${p._id}` } });
    await notifyPermission('projects.approve', 'project.rera_expiring', { ...vars, link: `/admin/projects/${p._id}` });
    out[status] += 1;
  }
  return out;
}

async function run(now = new Date()) {
  return { agentRegistrations: await agentRegistrations(now), projects: await projectRegistrations(now) };
}

module.exports = { run, daysUntil, agentRegistrations, projectRegistrations };
