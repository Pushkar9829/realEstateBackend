// RE-F-10 seeker behaviour flags: a phone that enquires on more than N
// different listers or M localities within the window is flagged and, per
// seeker.autoAction, throttled (1 enquiry a day, manager queue) or blocked.
const crypto = require('crypto');
const { z } = require('zod');
const { SeekerFlag, Blocklist } = require('./models');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyPermission } = require('../notifications/service');

const phoneHash = (phone) => crypto.createHash('sha256').update(`phone:${String(phone).trim().toLowerCase()}`).digest('hex');
const mask = (phone) => `${String(phone).slice(0, 3)}******${String(phone).slice(-2)}`;

// Current restriction for a phone: 'blocked' | 'throttled' | null.
async function restriction(phone) {
  const h = phoneHash(phone);
  if (await Blocklist.exists({ type: 'seeker_phone', valueHash: h, $or: [{ until: null }, { until: { $gt: new Date() } }] })) return 'blocked';
  const f = await SeekerFlag.findOne({ phoneHash: h, status: { $in: ['open', 'actioned'] }, action: 'throttle', $or: [{ until: null }, { until: { $gt: new Date() } }] }).lean();
  return f ? 'throttled' : null;
}

// Evaluate after a new lead; returns the flag when one was raised.
async function evaluate(phone) {
  const { Lead } = require('../leads/models');
  const { Property } = require('../listings/models');
  const s = await settings.all();
  const since = new Date(Date.now() - s['seeker.windowDays'] * 86400000);
  const leads = await Lead.find({ 'buyer.phone': phone, createdAt: { $gt: since } }).select('propertyId').lean();
  const props = await Property.find({ _id: { $in: leads.map((l) => l.propertyId).filter(Boolean) } }).select('listerId location.localityId location.cityId').lean();
  const listers = new Set(props.map((p) => String(p.listerId)));
  const localities = new Set(props.map((p) => String(p.location && p.location.localityId)));
  if (listers.size <= s['seeker.maxDistinctListers'] && localities.size <= s['seeker.maxDistinctLocalities']) return null;
  const h = phoneHash(phone);
  if (await SeekerFlag.exists({ phoneHash: h, status: { $in: ['open', 'actioned'] } })) return null;
  const action = s['seeker.autoAction'] === 'block' ? 'block' : 'throttle';
  const flag = await SeekerFlag.create({
    flagNo: await counters.seekerFlagNo(), phoneHash: h, phoneMasked: mask(phone), rule: listers.size > s['seeker.maxDistinctListers'] ? 'many_listers' : 'many_localities',
    window: { from: since, to: new Date() }, counts: { listers: listers.size, localities: localities.size, cities: new Set(props.map((p) => String(p.location && p.location.cityId))).size, enquiries: leads.length },
    leadIds: leads.map((l) => l._id), status: 'open', action,
  });
  if (action === 'block') await Blocklist.updateOne({ type: 'seeker_phone', valueHash: h }, { $setOnInsert: { type: 'seeker_phone', valueHash: h, reason: `Seeker flag ${flag.flagNo}` } }, { upsert: true });
  await notifyPermission('users.manage', 'seeker.flagged', { flagNo: flag.flagNo, listers: listers.size, localities: localities.size });
  return flag;
}

function list(query) {
  const filter = query.status ? { status: query.status } : { status: 'open' };
  return paginate(SeekerFlag, filter, { ...query, sort: query.sort || '-createdAt' });
}

async function detail(id) {
  const { Lead } = require('../leads/models');
  const f = await SeekerFlag.findById(id).lean();
  if (!f) throw ApiError.notFound('Flag not found');
  const leads = await Lead.find({ _id: { $in: f.leadIds } }).select('leadNo stage propertyId createdAt sources assignedTo').populate('propertyId', 'listingNo title location.locality').lean();
  return { ...f, leads };
}

async function decide(id, body, req) {
  const d = z.object({ action: z.enum(['dismiss', 'throttle', 'block']), note: z.string().trim().min(3).max(500), days: z.number().int().min(1).max(365).optional() }).parse(body);
  const f = await SeekerFlag.findById(id);
  if (!f) throw ApiError.notFound('Flag not found');
  const until = d.days ? new Date(Date.now() + d.days * 86400000) : undefined;
  if (d.action === 'dismiss') {
    Object.assign(f, { status: 'cleared', action: 'none', note: d.note, decidedBy: req.user._id });
    await Blocklist.deleteOne({ type: 'seeker_phone', valueHash: f.phoneHash });
  } else {
    Object.assign(f, { status: 'actioned', action: d.action, until, note: d.note, decidedBy: req.user._id });
    if (d.action === 'block') await Blocklist.updateOne({ type: 'seeker_phone', valueHash: f.phoneHash }, { $set: { until, reason: d.note }, $setOnInsert: { type: 'seeker_phone', valueHash: f.phoneHash } }, { upsert: true });
    else await Blocklist.deleteOne({ type: 'seeker_phone', valueHash: f.phoneHash });
  }
  await f.save();
  await audit(req, { action: `seeker_flag.${d.action}`, entityType: 'SeekerFlag', entityId: f._id, reason: d.note });
  return f;
}

// Agent raises a flag by hand from the lead (rule "manual"); admins decide the action.
const manualSchema = z.object({ note: z.string().trim().min(10).max(1000) });

async function manualFlag(user, leadId, body, req) {
  const { note } = manualSchema.parse(body);
  const { Lead } = require('../leads/models');
  const reveal = require('../masking/reveal.service');
  const lead = await Lead.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!(await reveal.leadInScope(user, lead))) throw ApiError.forbidden('This lead is not assigned to you', 'OUT_OF_SCOPE');
  if (!lead.buyer || !lead.buyer.phone) throw ApiError.conflict('This lead has no phone to flag', 'NO_PHONE');
  const h = phoneHash(lead.buyer.phone);
  let flag = await SeekerFlag.findOne({ phoneHash: h, status: 'open' });
  if (flag) {
    flag.note = [flag.note, `${user.name || 'Agent'}: ${note}`].filter(Boolean).join(' | ').slice(0, 4000);
    if (!flag.leadIds.some((x) => String(x) === String(lead._id))) flag.leadIds.push(lead._id);
    await flag.save();
  } else {
    flag = await SeekerFlag.create({
      flagNo: await counters.seekerFlagNo(), phoneHash: h, phoneMasked: mask(lead.buyer.phone), rule: 'manual', window: { from: lead.createdAt, to: new Date() },
      counts: { enquiries: await Lead.countDocuments({ 'buyer.phone': lead.buyer.phone }) }, leadIds: [lead._id], status: 'open', action: 'none', note: `${user.name || 'Agent'}: ${note}`,
    });
    await notifyPermission('users.manage', 'seeker.flagged', { flagNo: flag.flagNo, listers: '-', localities: '-' });
  }
  lead.seekerFlagId = flag._id;
  lead.timeline.push({ type: 'seeker_flag', by: user._id, at: new Date(), data: { flagNo: flag.flagNo } });
  await lead.save();
  await audit(req, { action: 'seeker.flag.manual', entityType: 'SeekerFlag', entityId: flag._id, reason: note });
  return { flagNo: flag.flagNo, status: flag.status, rule: flag.rule };
}

module.exports = { restriction, evaluate, list, detail, decide, phoneHash, manualFlag };
