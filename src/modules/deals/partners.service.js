// Module H Could (RE-H-10..12): partner banks / NBFCs for home-loan referrals
// and rental-agreement service partners. Data goes to a partner only with an
// explicit, purpose-specific consent (ledger purpose partner_sharing); partner
// emails never carry lister contact data for loans. Fees are reporting-only.
const { z } = require('zod');
const { Partner, PartnerReferral, Deal } = require('./models');
const { Lead } = require('../leads/models');
const { Property } = require('../listings/models');
const { Project } = require('../projects/models');
const { User, Consent } = require('../auth/models');
const counters = require('../../core/counters');
const storage = require('../../core/storage');
const settings = require('../../core/settings');
const { toPaise, toRupees } = require('../../core/money');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser, sendNow } = require('../notifications/service');
const reveal = require('../masking/reveal.service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const LOAN_TYPES = ['bank', 'nbfc'];
const LOAN_FLOW = { referred: ['contacted', 'rejected', 'withdrawn'], contacted: ['sanctioned', 'rejected', 'withdrawn'], sanctioned: ['disbursed', 'rejected', 'withdrawn'], disbursed: [], rejected: [], withdrawn: [] };
const SERVICE_FLOW = { requested: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: [] };
const OPEN_LOAN = ['referred', 'contacted', 'sanctioned'];
const DISCLAIMER = 'The platform does not give lending or legal advice; the partner decides independently.';

const partnerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['bank', 'nbfc', 'rental_agreement', 'other']),
  cities: z.array(z.string().trim().min(2).max(60)).max(50).default([]),
  contact: z.object({ name: z.string().trim().max(80).optional(), email: z.string().email(), phone: z.string().trim().max(20).optional() }),
  payoutTerms: z.string().trim().max(1000).optional(),
  agreementFileId: oid.nullable().optional(), // uploaded with purpose signed_agreement (private)
  active: z.boolean().optional(),
});

const AGREEMENT_PURPOSES = ['signed_agreement'];

// The partner agreement is a private upload; null on edit removes it.
async function agreementFile(fileId, partnerId) {
  if (!fileId) return null;
  const file = await storage.FileModel.findOne({ _id: fileId, purpose: { $in: AGREEMENT_PURPOSES } });
  if (!file) throw ApiError.validation([{ in: 'body', path: 'agreementFileId', message: 'Upload the agreement first (purpose signed_agreement)' }]);
  if (file.attachedTo && file.attachedTo.id && (file.attachedTo.type !== 'Partner' || !partnerId || String(file.attachedTo.id) !== String(partnerId))) {
    throw ApiError.validation([{ in: 'body', path: 'agreementFileId', message: 'This file is already attached elsewhere' }]);
  }
  return file;
}

async function attach(file, partnerId) {
  if (!file) return;
  file.attachedTo = { type: 'Partner', id: partnerId };
  await file.save();
}

const priceBand = (paise) => {
  const lakh = toRupees(paise || 0) / 100000;
  if (!lakh) return 'not stated';
  const lo = Math.floor(lakh / 25) * 25;
  return `INR ${lo}-${lo + 25} lakh`;
};
const servesCity = (p, city) => !p.cities || !p.cities.length || p.cities.some((c) => c.toLowerCase() === String(city || '').toLowerCase());

// ---------------------------------------------------------------- admin partners

async function list(query) {
  const filter = {};
  if (query.type) filter.type = query.type;
  if (query.active) filter.active = query.active === 'true';
  if (query.city) filter.$or = [{ cities: { $size: 0 } }, { cities: new RegExp(`^${String(query.city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }];
  return Partner.find(filter).sort({ active: -1, name: 1 }).lean();
}

async function create(body, req) {
  const d = partnerSchema.parse(body);
  const file = await agreementFile(d.agreementFileId);
  const p = await Partner.create({ ...d, agreementFileId: file ? file._id : undefined });
  await attach(file, p._id);
  await audit(req, { action: 'partner.create', entityType: 'Partner', entityId: p._id, after: { name: p.name, type: p.type, agreementFileId: file ? String(file._id) : undefined } });
  return p;
}

async function edit(id, body, req) {
  const d = partnerSchema.partial().parse(body);
  const p = await Partner.findById(id);
  if (!p) throw ApiError.notFound('Partner not found');
  const before = { active: p.active, cities: p.cities, agreementFileId: p.agreementFileId ? String(p.agreementFileId) : null };
  const file = d.agreementFileId ? await agreementFile(d.agreementFileId, p._id) : null;
  Object.assign(p, d);
  if (d.agreementFileId === null) p.agreementFileId = undefined;
  await p.save();
  await attach(file, p._id);
  await audit(req, { action: 'partner.edit', entityType: 'Partner', entityId: p._id, before, after: d });
  return p;
}

// GET /api/admin/partners/:id/agreement -> a 10-minute signed link to the private file.
async function agreementUrl(id, req) {
  const p = await Partner.findById(id).select('name agreementFileId').lean();
  if (!p) throw ApiError.notFound('Partner not found');
  if (!p.agreementFileId) throw ApiError.notFound('No agreement uploaded for this partner', 'NO_AGREEMENT');
  const file = await storage.FileModel.findById(p.agreementFileId);
  if (!file) throw ApiError.notFound('The agreement file is missing', 'FILE_MISSING');
  await audit(req, { action: 'partner.agreement.view', entityType: 'Partner', entityId: p._id });
  return { url: storage.urlFor(file, 600), expiresAt: new Date(Date.now() + 600000), mime: file.mime, sizeBytes: file.sizeBytes };
}

function listReferrals(query) {
  const filter = {};
  if (query.kind) filter.kind = query.kind;
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.partnerId) filter.partnerId = query.partnerId;
  return paginate(PartnerReferral, filter, query, { populate: [{ path: 'partnerId', select: 'name type' }, { path: 'leadId', select: 'leadNo' }, { path: 'dealId', select: 'dealNo' }] });
}

const patchSchema = z.object({
  status: z.string().optional(),
  partnerRef: z.string().trim().max(80).optional(),
  note: z.string().trim().max(1000).optional(),
  payoutDue: z.coerce.number().min(0).optional(),
  payoutReceived: z.coerce.number().min(0).optional(),
  fileId: oid.optional(), // final rental agreement PDF
  sanctionedAmount: z.coerce.number().min(0).max(1e10).nullable().optional(), // rupees, loans only
  disbursedAmount: z.coerce.number().min(0).max(1e10).nullable().optional(), // rupees, loans only
});

async function patchReferral(id, body, req) {
  const d = patchSchema.parse(body);
  const r = await PartnerReferral.findById(id);
  if (!r) throw ApiError.notFound('Referral not found');
  const flow = r.kind === 'loan' ? LOAN_FLOW : SERVICE_FLOW;
  if (d.status && d.status !== r.status) {
    if (!(flow[r.status] || []).includes(d.status)) throw ApiError.conflict(`Cannot move ${r.kind.replace('_', ' ')} from "${r.status}" to "${d.status}"`, 'INVALID_TRANSITION');
    r.timeline.push({ type: 'status', by: req.user._id, at: new Date(), note: `${r.status} -> ${d.status}${d.note ? `: ${d.note}` : ''}` });
    r.status = d.status;
  } else if (d.note) r.timeline.push({ type: 'note', by: req.user._id, at: new Date(), note: d.note });
  if (d.partnerRef !== undefined) r.partnerRef = d.partnerRef;
  if (d.sanctionedAmount !== undefined || d.disbursedAmount !== undefined) {
    if (r.kind !== 'loan') throw ApiError.validation([{ in: 'body', path: d.sanctionedAmount !== undefined ? 'sanctionedAmount' : 'disbursedAmount', message: 'Sanctioned and disbursed amounts apply to loan referrals only' }]);
    const money = (v) => (v === null ? undefined : toPaise(v));
    if (d.sanctionedAmount !== undefined) r.sanctionedAmount = money(d.sanctionedAmount);
    if (d.disbursedAmount !== undefined) r.disbursedAmount = money(d.disbursedAmount);
    if (r.sanctionedAmount != null && r.disbursedAmount != null && r.disbursedAmount > r.sanctionedAmount) throw ApiError.validation([{ in: 'body', path: 'disbursedAmount', message: 'The disbursed amount cannot exceed the sanctioned amount' }]);
  }
  if (d.payoutDue !== undefined || d.payoutReceived !== undefined) {
    const due = d.payoutDue !== undefined ? toPaise(d.payoutDue) : (r.payout && r.payout.due) || 0;
    const received = d.payoutReceived !== undefined ? toPaise(d.payoutReceived) : (r.payout && r.payout.received) || 0;
    r.payout = { due, received, status: received >= due && due > 0 ? 'received' : received > 0 ? 'partial' : due > 0 ? 'due' : 'none' };
  }
  if (d.fileId && r.kind === 'rental_agreement') {
    r.documents.push(d.fileId);
    if (r.dealId) await Deal.updateOne({ _id: r.dealId }, { $push: { documents: { kind: 'other', label: 'Rental agreement (partner)', fileId: d.fileId, uploadedBy: req.user._id } } });
  }
  await r.save();
  await audit(req, { action: 'partner.referral.update', entityType: 'PartnerReferral', entityId: r._id, after: d });
  if (d.status) await notifyStatus(r);
  return r;
}

async function notifyStatus(r) {
  const partner = await Partner.findById(r.partnerId).select('name');
  if (r.kind === 'loan') {
    const lead = await Lead.findById(r.leadId).select('assignedTo buyer');
    const agent = lead && lead.assignedTo && await User.findById(lead.assignedTo);
    const vars = { refNo: r.refNo, status: r.status, partner: partner ? partner.name : '', leadId: String(r.leadId) };
    if (agent) await notifyUser({ user: agent, event: 'referral.status_changed', vars });
    if (lead && lead.buyer && lead.buyer.phone && ['sanctioned', 'disbursed', 'rejected'].includes(r.status)) await sendNow({ channel: 'sms', to: lead.buyer.phone, event: 'referral.status_changed', vars }).catch(() => {});
    if (lead) await Lead.updateOne({ _id: lead._id }, { $push: { timeline: { type: 'referral', at: new Date(), data: { refNo: r.refNo, status: r.status } } } });
  } else {
    const deal = await Deal.findById(r.dealId).select('dealNo agentId listerId');
    const vars = { refNo: r.refNo, status: r.status.replace('_', ' '), dealNo: deal ? deal.dealNo : '' };
    for (const uid of deal ? [deal.agentId, deal.listerId] : []) {
      const u = await User.findById(uid);
      if (u) await notifyUser({ user: u, event: 'service.request_updated', vars: { ...vars, link: String(uid) === String(deal.agentId) ? `/agent/deals/${deal._id}` : '/lister/leads' }, channels: ['in_app', 'email'] });
    }
  }
}

// ---------------------------------------------------------------- agent

async function consent(lead, req) {
  const subject = lead.buyer.userId ? { subjectType: 'user', subjectId: lead.buyer.userId } : { subjectType: 'buyer_contact', subjectId: lead.buyer.contactId || lead._id };
  const [c] = await Consent.create([{ ...subject, purpose: 'partner_sharing', source: 'agent', noticeVersion: 'partner-v1', ip: req.ip }]);
  return c;
}

const loanSchema = z.object({ partnerId: oid, loanAmount: z.coerce.number().positive().max(1e10), consent: z.literal(true, { errorMap: () => ({ message: 'Tick the buyer consent to share their details with this partner' }) }), note: z.string().trim().max(500).optional() });

async function referLoan(user, leadId, body, req) {
  if (!(await settings.get('partners.loanReferralEnabled'))) throw ApiError.conflict('Home-loan referrals are switched off', 'FEATURE_DISABLED');
  const d = loanSchema.parse(body);
  const lead = await Lead.findById(leadId);
  if (!lead) throw ApiError.notFound('Lead not found');
  if (!(await reveal.leadInScope(user, lead))) throw ApiError.forbidden('This lead is not assigned to you', 'OUT_OF_SCOPE');
  const partner = await Partner.findOne({ _id: d.partnerId, active: true, type: { $in: LOAN_TYPES } });
  if (!partner) throw ApiError.notFound('Active bank / NBFC partner not found');
  const target = lead.projectId ? await Project.findById(lead.projectId).select('location.city configurations.priceMin') : await Property.findById(lead.propertyId).select('location.city price');
  const city = (target && target.location && target.location.city) || (lead.requirement && lead.requirement.city);
  if (!servesCity(partner, city)) throw ApiError.conflict(`${partner.name} does not serve ${city}`, 'PARTNER_CITY');
  if (await PartnerReferral.exists({ kind: 'loan', leadId: lead._id, partnerId: partner._id, status: { $in: OPEN_LOAN } })) throw ApiError.conflict('This lead already has an open referral with this partner', 'REFERRAL_EXISTS');

  const c = await consent(lead, req);
  const r = await PartnerReferral.create({
    refNo: await counters.partnerReferralNo(), kind: 'loan', partnerId: partner._id, partnerName: partner.name, leadId: lead._id, city, agentId: user._id,
    consentIds: [c._id], amount: toPaise(d.loanAmount), status: 'referred', timeline: [{ type: 'referred', by: user._id, at: new Date(), note: d.note }],
  });
  const price = target && (target.price ? target.price.amount : target.configurations && target.configurations[0] && target.configurations[0].priceMin);
  // Buyer data only: no lister name, phone or address (acceptance 8).
  await sendNow({ channel: 'email', to: partner.contact.email, event: 'referral.sent_partner', vars: { refNo: r.refNo, buyerName: lead.buyer.name, buyerPhone: lead.buyer.phone, amount: d.loanAmount.toLocaleString('en-IN'), city, priceBand: priceBand(price), partner: partner.name } }).catch(() => {});
  if (lead.buyer.phone) await sendNow({ channel: 'sms', to: lead.buyer.phone, event: 'referral.sent_buyer', vars: { partner: partner.name, refNo: r.refNo } }).catch(() => {});
  lead.timeline.push({ type: 'referral', by: user._id, at: new Date(), data: { refNo: r.refNo, partner: partner.name, status: 'referred' } });
  await lead.save();
  await audit(req, { action: 'partner.referral.create', entityType: 'PartnerReferral', entityId: r._id, after: { leadId: lead._id, partnerId: partner._id } });
  return { ...r.toObject(), disclaimer: DISCLAIMER };
}

const serviceSchema = z.object({
  partnerId: oid,
  fee: z.coerce.number().min(0).max(1e7).default(0),
  payer: z.enum(['tenant', 'landlord', 'split', 'platform']),
  tenantConsent: z.literal(true, { errorMap: () => ({ message: 'The tenant must consent to share details with the partner' }) }),
  landlordConsent: z.literal(true, { errorMap: () => ({ message: 'The landlord must consent to share details with the partner' }) }),
  note: z.string().trim().max(500).optional(),
});

async function requestRentalAgreement(user, dealId, body, req) {
  if (!(await settings.get('partners.rentalAgreementEnabled'))) throw ApiError.conflict('The rental agreement service is switched off', 'FEATURE_DISABLED');
  const d = serviceSchema.parse(body);
  const deal = await Deal.findById(dealId);
  if (!deal) throw ApiError.notFound('Deal not found');
  const lead = await Lead.findById(deal.leadId);
  if (!(await reveal.leadInScope(user, lead)) && String(deal.agentId) !== String(user._id)) throw ApiError.forbidden('This deal is not yours', 'OUT_OF_SCOPE');
  if (deal.dealType !== 'rent') throw ApiError.conflict('Rental agreements are for rent deals', 'NOT_RENT');
  if (['cancelled', 'rejected', 'reversed'].includes(deal.status)) throw ApiError.conflict(`The deal is ${deal.status}`, 'DEAL_CLOSED');
  const partner = await Partner.findOne({ _id: d.partnerId, active: true, type: 'rental_agreement' });
  if (!partner) throw ApiError.notFound('Active rental agreement partner not found');
  const property = await Property.findById(deal.propertyId).select('location.city');
  const city = property && property.location && property.location.city;
  if (!servesCity(partner, city)) throw ApiError.conflict(`${partner.name} does not serve ${city}`, 'PARTNER_CITY');
  if (await PartnerReferral.exists({ kind: 'rental_agreement', dealId: deal._id, status: { $in: ['requested', 'in_progress'] } })) throw ApiError.conflict('A rental agreement request is already open for this deal', 'REFERRAL_EXISTS');

  const landlord = await User.findById(deal.listerId).select('name phone');
  const tenantConsent = await consent(lead, req);
  const [landlordConsent] = await Consent.create([{ subjectType: 'user', subjectId: landlord._id, purpose: 'partner_sharing', source: 'agent', noticeVersion: 'partner-v1', ip: req.ip }]);
  const r = await PartnerReferral.create({
    refNo: await counters.partnerReferralNo(), kind: 'rental_agreement', partnerId: partner._id, partnerName: partner.name, leadId: lead._id, dealId: deal._id, city, agentId: user._id,
    consentIds: [tenantConsent._id, landlordConsent._id], fee: toPaise(d.fee), payer: d.payer, status: 'requested', timeline: [{ type: 'requested', by: user._id, at: new Date(), note: d.note }],
  });
  // The landlord's data is shared with this partner only (H3 step 5).
  await sendNow({ channel: 'email', to: partner.contact.email, event: 'service.request_partner', vars: { refNo: r.refNo, dealNo: deal.dealNo, tenantName: lead.buyer.name, tenantPhone: lead.buyer.phone, landlordName: landlord.name, landlordPhone: landlord.phone, city, fee: d.fee.toLocaleString('en-IN'), payer: d.payer, partner: partner.name } }).catch(() => {});
  await audit(req, { action: 'partner.service.create', entityType: 'PartnerReferral', entityId: r._id, after: { dealId: deal._id, partnerId: partner._id } });
  return { ...r.toObject(), disclaimer: DISCLAIMER };
}

module.exports = { list, create, edit, agreementUrl, listReferrals, patchReferral, referLoan, requestRentalAgreement, DISCLAIMER };
