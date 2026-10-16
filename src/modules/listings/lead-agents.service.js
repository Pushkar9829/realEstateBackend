// Workflow A4 step 4 / RE-A-15 / RE-A-18: when a listing is paused, resumed,
// taken off market, sold elsewhere or expires, the agents holding open leads
// on it are told in-app. Leads are read only (module C owns them).
const { User } = require('../auth/models');
const { notifyUser } = require('../notifications/service');
const logger = require('../../core/logger');

const OPEN_STAGES = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation', 'booking'];
const REASON = {
  sold_outside: 'sold outside the platform', rented_outside: 'rented outside the platform', no_longer_available: 'no longer available',
  agreement_terminated: 'agreement terminated', other: 'taken off market', expired: 'listing expired', suspended: 'suspended by our team',
};
const PAUSE_REASON = { lister: 'paused by the lister', no_reply: 'no reply to the availability check', admin_review: 'paused for review' };

// Which agent event (if any) a status change means.
function eventFor(from, to) {
  if (to === 'paused' && from !== 'paused') return 'listing.paused';
  if (from === 'paused' && to === 'live') return 'listing.resumed';
  if (['live', 'paused'].includes(from) && ['inactive', 'expired', 'suspended'].includes(to)) return 'listing.deactivated';
  return null;
}

async function notifyLeadAgents(p, { from, to }) {
  const event = eventFor(from, to);
  if (!event) return 0;
  const { Lead } = require('../leads/models');
  const leads = await Lead.find({ $or: [{ propertyId: p._id }, { linkedProperties: p._id }], stage: { $in: OPEN_STAGES }, assignedTo: { $ne: null }, mergedInto: null })
    .select('_id assignedTo').sort({ lastActivityAt: -1 }).lean();
  const byAgent = new Map();
  for (const l of leads) {
    const k = String(l.assignedTo);
    if (!byAgent.has(k)) byAgent.set(k, { leadId: String(l._id), count: 0 });
    byAgent.get(k).count += 1;
  }
  if (!byAgent.size) return 0;
  const agents = await User.find({ _id: { $in: [...byAgent.keys()] }, status: 'active' });
  const reason = event === 'listing.paused'
    ? (p.pause && (p.pause.note || PAUSE_REASON[p.pause.reason])) || 'paused'
    : REASON[to === 'inactive' ? p.inactiveReason || 'other' : to] || to;
  for (const a of agents) {
    const { leadId, count } = byAgent.get(String(a._id));
    await notifyUser({ user: a, event, channels: ['in_app'], vars: { listingNo: p.listingNo, title: p.title || p.listingNo, reason, leadId, leadCount: count, propertyId: String(p._id) } });
  }
  return agents.length;
}

// Called from the Property post-save hook with the transitions recorded by setStatus.
async function flush(p) {
  const pending = (p.$locals && p.$locals.statusChanges) || [];
  if (!pending.length) return;
  p.$locals.statusChanges = [];
  for (const change of pending) {
    try { await notifyLeadAgents(p, change); } catch (err) { logger.warn({ err: err.message, propertyId: String(p._id) }, 'lead agent notification failed'); }
  }
}

module.exports = { notifyLeadAgents, flush, eventFor };
