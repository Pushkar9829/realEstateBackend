// RE-B-10 staff contact reveal: agents see buyer and lister contacts only for
// their own leads, managers for leads of the teams they manage, admins with
// contacts.view. Every reveal writes a contactreveals record.
const { z } = require('zod');
const { ApiError, paginate } = require('../../core/http');
const { User } = require('../auth/models');
const { notifyPermission } = require('../notifications/service');

const isAdmin = (u) => u.role === 'superadmin' || (u.role === 'admin' && (u.permissions || []).includes('contacts.view'));

async function managedTeamIds(user) {
  const { Team } = require('../teams/models');
  return Team.find({ managerIds: user._id }).distinct('_id');
}

// Lead is "in scope" for the staff member.
async function leadInScope(user, lead) {
  if (isAdmin(user)) return true;
  if (lead.assignedTo && String(lead.assignedTo) === String(user._id)) return true;
  if (user.role === 'manager' && lead.teamId) return (await managedTeamIds(user)).some((t) => String(t) === String(lead.teamId));
  return false;
}

// Property is "in scope" when it is linked to an open lead the staff member can see.
async function propertyInScope(user, propertyId) {
  if (isAdmin(user) || user.role === 'superadmin') return true;
  const { Lead } = require('../leads/models');
  const linked = { $or: [{ propertyId }, { linkedProperties: propertyId }] };
  if (await Lead.exists({ ...linked, assignedTo: user._id })) return true;
  if (user.role === 'manager') {
    const teams = await managedTeamIds(user);
    return Boolean(await Lead.exists({ ...linked, teamId: { $in: teams } }));
  }
  return false;
}

async function record(req, entry) {
  const { ContactReveal } = require('../reports/models');
  await ContactReveal.create({ ...entry, actorId: req.user._id, ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300) });
  // Unusual volume: more than 50 reveals by one person today.
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const n = await ContactReveal.countDocuments({ actorId: req.user._id, createdAt: { $gte: since } });
  if (n === 51) await notifyPermission('logs.view', 'contact.revealed_bulk', { name: req.user.name, count: n });
}

const fieldSchema = z.object({ field: z.enum(['phone', 'email']).default('phone') });

async function revealBuyer(leadId, body, req) {
  const { field } = fieldSchema.parse(body || {});
  const { Lead } = require('../leads/models');
  const lead = await Lead.findById(leadId).lean();
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!(await leadInScope(req.user, lead))) throw ApiError.forbidden('This lead is not assigned to you', 'OUT_OF_SCOPE');
  await record(req, { subjectType: 'buyer', subjectId: lead.buyer.contactId || lead._id, leadId: lead._id, field });
  return { field, value: lead.buyer[field] || null, name: lead.buyer.name };
}

async function revealLister(propertyId, body, req) {
  const { field } = fieldSchema.parse(body || {});
  const { Property } = require('../listings/models');
  const p = await Property.findById(propertyId).select('listerId listingNo').lean();
  if (!p) throw ApiError.notFound('Property not found');
  if (!(await propertyInScope(req.user, p._id))) throw ApiError.forbidden('This property is not linked to your leads', 'OUT_OF_SCOPE');
  const lister = await User.findById(p.listerId).select('name phone email').lean();
  await record(req, { subjectType: 'lister', subjectId: p.listerId, propertyId: p._id, field });
  return { field, value: lister[field] || null, name: lister.name };
}

function listReveals(query) {
  const { ContactReveal } = require('../reports/models');
  const filter = {};
  if (query.actorId) filter.actorId = query.actorId;
  if (query.subjectType) filter.subjectType = query.subjectType;
  if (query.from || query.to) filter.createdAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  return paginate(ContactReveal, filter, { ...query, sort: query.sort || '-createdAt' }, { populate: { path: 'actorId', select: 'name email role' } });
}

module.exports = { leadInScope, propertyInScope, managedTeamIds, revealBuyer, revealLister, listReveals, isAdmin };
