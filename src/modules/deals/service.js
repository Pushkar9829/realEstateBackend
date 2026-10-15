// Module H - deals and receipt verification (spec 4.8).
// Agent: draft -> documents -> submit (closure gates RE-H-03, duplicate receipts
// RE-H-05). Admin: claim (30 min lock) -> verify / return / reject. Verify and
// reverse run in one MongoDB transaction (RE-H-06 / RE-H-08): deal, lead,
// listing or project inventory, receivable, agreement totals and the MLM outbox
// event commit together or not at all. Money is paise in the DB, rupees in.
const mongoose = require('mongoose');
const { z } = require('zod');
const { Deal } = require('./models');
const { Lead, SiteVisit, Offer } = require('../leads/models');
const { Property } = require('../listings/models');
const { Project } = require('../projects/models');
const { Agreement } = require('../approvals/models');
const { User } = require('../auth/models');
const { Team } = require('../teams/models');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const storage = require('../../core/storage');
const outbox = require('../../core/outbox');
const events = require('../../core/events');
const { toPaise, toRupees, percentOf } = require('../../core/money');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const { assertTransition } = require('../../constants/status');
const { notifyUser, notifyPermission, sendNow } = require('../notifications/service');
const reveal = require('../masking/reveal.service');
const common = require('../leads/common');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const OPEN = ['draft', 'submitted', 'under_review', 'returned'];
const EDITABLE = ['draft', 'returned'];
const LOCK_MS = 30 * 60000;
const MAX_RESUBMISSIONS = 5;
const DOC_LIMITS = { receipt: 10, agreement: 5, other: 10 };
const DOC_PURPOSE = { receipt: ['receipt'], agreement: ['agreement_doc', 'signed_agreement'], other: ['receipt', 'agreement_doc', 'signed_agreement'] };
const inr = (paise) => toRupees(paise || 0).toLocaleString('en-IN');
const field = (path, message) => ApiError.validation([{ in: 'body', path, message }]);

// ---------------------------------------------------------------- validation

const money = z.coerce.number().positive().max(1e10);
const fields = {
  propertyId: oid.optional(),
  projectId: oid.optional(),
  unitConfigId: oid.optional(),
  unitNo: z.string().trim().max(40).optional(),
  dealType: z.enum(['sale', 'rent']).optional(),
  agreedPrice: money.optional(),
  monthlyRent: money.optional(),
  bookingAmount: money.optional(),
  bookingDate: z.coerce.date().optional(),
  paymentMode: z.enum(['bank_transfer', 'cheque', 'upi', 'cash', 'dd', 'other']).optional(),
  paymentReference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(2000).optional(),
  justification: z.string().trim().max(2000).optional(),
  offerNote: z.string().trim().max(1000).optional(),
};
const createSchema = z.object({ leadId: oid, offerId: oid.optional(), ...fields });
const editSchema = z.object(fields);

// ---------------------------------------------------------------- helpers

async function managerTeams(user) {
  return user.role === 'manager' ? reveal.managedTeamIds(user) : null;
}

// Agents see their own deals; managers also their teams' deals.
async function agentScope(user) {
  const teams = await managerTeams(user);
  return teams ? { $or: [{ agentId: user._id }, { teamId: { $in: teams } }] } : { agentId: user._id };
}

async function adminScope(user) {
  const teams = await managerTeams(user);
  return teams ? { teamId: { $in: teams } } : {};
}

async function ownDeal(user, id) {
  if (!oid.safeParse(String(id)).success) throw ApiError.notFound('Deal not found');
  const deal = await Deal.findOne({ _id: id, ...(await agentScope(user)) });
  if (!deal) throw ApiError.notFound('Deal not found');
  return deal;
}

function history(deal, to, actor, note) {
  deal.statusHistory.push({ from: deal.status, to, actor, note });
  deal.status = to;
}

function move(deal, to, actor, note) {
  assertTransition('deal', deal.status, to);
  history(deal, to, actor, note);
}

const propertyRef = (p) => (p ? `${p.listingNo || p.projectNo} ${p.title || p.name || ''}`.trim() : '');

// Agreement effective on the booking date (RE-H-09); falls back to the
// listing's accepted commission for listings created before the registry.
async function effectiveAgreement(deal) {
  const key = deal.projectId ? { projectId: deal.projectId } : { propertyId: deal.propertyId };
  const on = deal.bookingDate || new Date();
  const ag = await Agreement.findOne({ ...key, status: { $in: ['accepted', 'countersigned', 'superseded'] }, effectiveFrom: { $ne: null, $lte: on } })
    .sort({ effectiveFrom: -1, version: -1 });
  if (ag && (!ag.supersededAt || ag.supersededAt > on || ag.status !== 'superseded')) return { id: ag._id, percent: ag.commissionPercent, agreementNo: ag.agreementNo };
  const target = deal.projectId ? await Project.findById(deal.projectId).select('commission') : await Property.findById(deal.propertyId).select('commission');
  if (target && target.commission && target.commission.percent) return { id: null, percent: target.commission.percent, agreementNo: null };
  return null;
}

// Server-side commission (RE-H-09): basis by purpose, rounded to the rupee, GST split by state.
async function computeCommission(deal) {
  const ag = await effectiveAgreement(deal);
  if (!ag) return null;
  const basisAmount = deal.dealType === 'rent' ? (deal.monthlyRent || 0) * 12 : (deal.agreedPrice || 0);
  const amount = Math.round(percentOf(basisAmount, ag.percent) / 100) * 100;
  const [gstPercent, companyState, lister] = await Promise.all([settings.get('invoice.gstPercent'), settings.get('company.state'), User.findById(deal.listerId).select('billing address')]);
  const listerState = (lister && ((lister.billing && lister.billing.state) || (lister.address && lister.address.state))) || companyState;
  const interState = String(listerState).trim().toLowerCase() !== String(companyState).trim().toLowerCase();
  const gstAmount = percentOf(amount, gstPercent);
  const half = Math.floor(gstAmount / 2);
  return {
    agreementId: ag.id, agreementNo: ag.agreementNo, commissionPercent: ag.percent,
    commissionBasis: deal.dealType === 'rent' ? 'annual_rent' : 'sale_price', commissionAmount: amount, gstAmount,
    gst: interState ? { interState, igst: gstAmount, cgst: 0, sgst: 0, percent: gstPercent } : { interState, cgst: half, sgst: gstAmount - half, igst: 0, percent: gstPercent },
  };
}

// POST /api/agent/deals/preview-commission (DealForm live preview): the same
// computeCommission() as create / submit / verify, on an unsaved deal built
// from the lead or the chosen listing / project. Amounts in paise; nothing saved.
const previewSchema = z.object({
  leadId: oid.optional(), propertyId: oid.optional(), projectId: oid.optional(),
  dealType: z.enum(['sale', 'rent']).optional(),
  agreedPrice: z.coerce.number().min(0).max(1e10).optional(),
  monthlyRent: z.coerce.number().min(0).max(1e10).optional(),
  bookingDate: z.coerce.date().optional(),
});

async function previewCommission(user, body) {
  const d = previewSchema.parse(body || {});
  let lead = null;
  if (d.leadId) {
    lead = await common.leadOr404(d.leadId);
    if (!(await reveal.leadInScope(user, lead))) throw ApiError.forbidden('This lead is not assigned to you', 'OUT_OF_SCOPE');
  }
  const projectId = d.projectId || (!d.propertyId && lead && lead.projectId ? String(lead.projectId) : undefined);
  const propertyId = projectId ? undefined : (d.propertyId || (lead && lead.propertyId ? String(lead.propertyId) : undefined));
  if (!propertyId && !projectId) throw field('propertyId', 'Choose the property or project for this deal');
  let listerId; let dealType;
  if (projectId) {
    const pr = await Project.findById(projectId).select('builderId');
    if (!pr) throw ApiError.notFound('Project not found');
    listerId = pr.builderId;
    dealType = 'sale';
  } else {
    const p = await Property.findById(propertyId).select('listerId purpose');
    if (!p) throw ApiError.notFound('Property not found');
    listerId = p.listerId;
    dealType = p.purpose === 'rent' ? 'rent' : 'sale';
  }
  if (d.dealType && d.dealType !== dealType) throw field('dealType', `This listing is for ${dealType}`);
  const deal = {
    propertyId, projectId, listerId, dealType, bookingDate: d.bookingDate || new Date(),
    agreedPrice: d.agreedPrice !== undefined ? toPaise(d.agreedPrice) : undefined,
    monthlyRent: d.monthlyRent !== undefined ? toPaise(d.monthlyRent) : undefined,
  };
  const c = await computeCommission(deal);
  const basisAmount = dealType === 'rent' ? (deal.monthlyRent || 0) * 12 : (deal.agreedPrice || 0);
  if (!c) return { available: false, dealType, basis: dealType === 'rent' ? 'annual_rent' : 'sale_price', basisAmount, reason: 'No commission agreement is in force for this listing on the booking date' };
  return {
    available: true, dealType, agreementNo: c.agreementNo, percent: c.commissionPercent, basis: c.commissionBasis, basisAmount,
    commission: c.commissionAmount, gstAmount: c.gstAmount, gst: c.gst, total: c.commissionAmount + c.gstAmount, bookingDate: deal.bookingDate,
  };
}

function applyCommission(deal, c) {
  if (!c) return;
  Object.assign(deal, { agreementId: c.agreementId || undefined, commissionPercent: c.commissionPercent, commissionBasis: c.commissionBasis, commissionAmount: c.commissionAmount, gstAmount: c.gstAmount, gst: c.gst });
}

// Accepted offer -> prefill; a different price or token needs a note (min 20).
function offerTerms(offer) {
  const rounds = [...offer.rounds].reverse();
  const acc = rounds.find((r) => r.kind === 'accept');
  const priced = rounds.find((r) => r.amount);
  const tokened = rounds.find((r) => r.terms && r.terms.token);
  return { amount: (acc && acc.amount) || (priced && priced.amount), token: tokened && tokened.terms.token };
}

function assignFields(deal, d) {
  const set = (k, v) => { if (v !== undefined) deal[k] = v; };
  set('unitNo', d.unitNo);
  set('unitConfigId', d.unitConfigId);
  set('agreedPrice', d.agreedPrice !== undefined ? toPaise(d.agreedPrice) : undefined);
  set('monthlyRent', d.monthlyRent !== undefined ? toPaise(d.monthlyRent) : undefined);
  set('bookingAmount', d.bookingAmount !== undefined ? toPaise(d.bookingAmount) : undefined);
  set('bookingDate', d.bookingDate);
  set('paymentMode', d.paymentMode);
  set('paymentReference', d.paymentReference);
  set('notes', d.notes);
  set('justification', d.justification);
}

async function checkOfferNote(deal, d) {
  if (!deal.offerId) return;
  const offer = await Offer.findById(deal.offerId);
  if (!offer) return;
  const t = offerTerms(offer);
  const priceChanged = t.amount && deal.agreedPrice && deal.agreedPrice !== t.amount;
  const tokenChanged = t.token && deal.bookingAmount && deal.bookingAmount !== t.token;
  if ((priceChanged || tokenChanged) && String(d.offerNote || deal.justification || '').trim().length < 20) {
    throw field('offerNote', 'The price or token differs from the accepted offer; add a note of at least 20 characters');
  }
}

// ---------------------------------------------------------------- agent

async function create(user, body, req) {
  const d = createSchema.parse(body);
  const lead = await common.leadOr404(d.leadId);
  if (!(await reveal.leadInScope(user, lead))) throw ApiError.forbidden('This lead is not assigned to you', 'OUT_OF_SCOPE');
  if (!common.OPEN_STAGES.includes(lead.stage)) throw ApiError.conflict(`A ${lead.stage.replace('_', ' ')} lead cannot get a new deal`, 'LEAD_CLOSED');
  const open = await Deal.findOne({ leadId: lead._id, status: { $in: OPEN } }).select('dealNo').lean();
  if (open) throw ApiError.conflict(`Lead already has open deal ${open.dealNo}`, 'OPEN_DEAL_EXISTS', { dealNo: open.dealNo });

  let offer = null;
  if (d.offerId) {
    offer = await Offer.findOne({ _id: d.offerId, leadId: lead._id });
    if (!offer) throw ApiError.notFound('Offer not found on this lead');
    if (offer.status !== 'accepted') throw ApiError.conflict('Only an accepted offer can become a deal', 'OFFER_NOT_ACCEPTED');
  }
  const projectId = d.projectId || (offer && offer.projectId && String(offer.projectId)) || (lead.projectId && String(lead.projectId));
  const propertyId = projectId ? undefined : (d.propertyId || (offer && offer.propertyId && String(offer.propertyId)) || (lead.propertyId && String(lead.propertyId)));
  if (!propertyId && !projectId) throw field('propertyId', 'Choose the property or project for this deal');

  let listerId; let dealType;
  if (projectId) {
    const pr = await Project.findById(projectId).select('builderId configurations status');
    if (!pr) throw ApiError.notFound('Project not found');
    listerId = pr.builderId;
    dealType = 'sale';
    const cfg = d.unitConfigId || (lead.unitConfigId && String(lead.unitConfigId));
    if (cfg && !pr.configurations.id(cfg)) throw field('unitConfigId', 'Configuration not found in this project');
    d.unitConfigId = cfg;
  } else {
    const p = await Property.findById(propertyId).select('listerId purpose status');
    if (!p) throw ApiError.notFound('Property not found');
    if (p.purpose === 'sale' && await Deal.exists({ propertyId: p._id, status: 'verified' })) throw ApiError.conflict('Property already sold', 'PROPERTY_SOLD');
    listerId = p.listerId;
    dealType = p.purpose === 'rent' ? 'rent' : 'sale';
  }
  if (d.dealType && d.dealType !== dealType) throw field('dealType', `This listing is for ${dealType}`);

  const lister = await User.findById(listerId).select('referredBy');
  const deal = new Deal({
    dealNo: await counters.dealNo(), leadId: lead._id, propertyId, projectId, agentId: lead.assignedTo || user._id, teamId: lead.teamId, listerId, dealType,
    offerId: offer ? offer._id : undefined, status: 'draft',
    referral: { buyerReferralCode: lead.referralCode || undefined, listerReferralCode: (lister && lister.referredBy) || undefined },
    statusHistory: [{ from: null, to: 'draft', actor: user._id, note: 'Created' }],
  });
  if (offer) { // prefill from the accepted offer (acceptance 7)
    const t = offerTerms(offer);
    if (dealType === 'rent') deal.monthlyRent = t.amount; else deal.agreedPrice = t.amount;
    if (t.token) deal.bookingAmount = t.token;
  }
  assignFields(deal, d);
  await checkOfferNote(deal, d);
  applyCommission(deal, await computeCommission(deal));
  await deal.save();
  if (offer) { offer.dealId = deal._id; await offer.save(); }
  common.entry(lead, 'deal', user._id, { dealNo: deal.dealNo, status: 'draft' });
  lead.lastActivityAt = new Date();
  await lead.save();
  await audit(req, { action: 'deal.create', entityType: 'Deal', entityId: deal._id, after: { dealNo: deal.dealNo, leadId: lead._id } });
  return present(deal);
}

async function edit(user, id, body, req) {
  const d = editSchema.parse(body);
  const deal = await ownDeal(user, id);
  if (!EDITABLE.includes(deal.status)) throw ApiError.conflict(`A ${deal.status.replace('_', ' ')} deal cannot be edited`, 'DEAL_LOCKED');
  if (d.dealType && d.dealType !== deal.dealType) throw field('dealType', 'The deal type follows the listing purpose');
  assignFields(deal, d);
  await checkOfferNote(deal, d);
  applyCommission(deal, await computeCommission(deal));
  await deal.save();
  await audit(req, { action: 'deal.edit', entityType: 'Deal', entityId: deal._id, after: d });
  return present(deal);
}

const docSchema = z.object({ fileId: oid, kind: z.enum(['receipt', 'agreement', 'other']), label: z.string().trim().max(120).optional(), reference: z.string().trim().max(80).optional() });

async function addDocument(user, id, body, req) {
  const d = docSchema.parse(body);
  const deal = await ownDeal(user, id);
  if (!EDITABLE.includes(deal.status)) throw ApiError.conflict(`Documents cannot change on a ${deal.status.replace('_', ' ')} deal`, 'DEAL_LOCKED');
  const count = deal.documents.filter((x) => x.kind === d.kind).length;
  if (count >= DOC_LIMITS[d.kind]) throw ApiError.conflict(`At most ${DOC_LIMITS[d.kind]} ${d.kind} documents`, 'DOCUMENT_LIMIT');
  const file = await storage.FileModel.findOne({ _id: d.fileId, ownerId: user._id });
  if (!file) throw ApiError.badRequest('Upload the file first (purpose receipt or agreement_doc)', 'FILE_NOT_FOUND');
  if (!DOC_PURPOSE[d.kind].includes(file.purpose)) throw ApiError.badRequest(`A ${d.kind} must be uploaded with purpose ${DOC_PURPOSE[d.kind][0]}`, 'WRONG_PURPOSE');
  if (deal.documents.some((x) => String(x.fileId) === String(file._id))) throw ApiError.conflict('This file is already attached', 'DUPLICATE_DOCUMENT');
  deal.documents.push({ kind: d.kind, label: d.label || file.purpose, fileId: file._id, sha256: file.sha256, reference: d.reference, uploadedBy: user._id });
  file.attachedTo = { type: 'Deal', id: deal._id };
  await Promise.all([deal.save(), file.save()]);
  await audit(req, { action: 'deal.document.add', entityType: 'Deal', entityId: deal._id, after: { kind: d.kind, fileId: file._id } });
  return present(deal);
}

async function removeDocument(user, id, docId, req) {
  const deal = await ownDeal(user, id);
  if (!EDITABLE.includes(deal.status)) throw ApiError.conflict(`Documents cannot change on a ${deal.status.replace('_', ' ')} deal`, 'DEAL_LOCKED');
  const doc = deal.documents.id(docId);
  if (!doc) throw ApiError.notFound('Document not found');
  doc.deleteOne();
  await deal.save();
  await audit(req, { action: 'deal.document.remove', entityType: 'Deal', entityId: deal._id, before: { fileId: doc.fileId, kind: doc.kind } });
  return present(deal);
}

// Closure gates (RE-H-03) and the business rules of spec 4.8. Returns warnings.
async function gates(deal, lead) {
  const errors = [];
  const add = (path, message) => errors.push({ in: 'body', path, message });
  const visit = await SiteVisit.findOne({ leadId: deal.leadId, status: 'completed', ...(deal.propertyId ? { propertyId: deal.propertyId } : {}) }).select('_id');
  if (!visit) throw ApiError.validation([{ in: 'body', path: 'siteVisit', message: 'A completed site visit is required' }], 'A completed site visit is required');
  if (!deal.documents.some((x) => x.kind === 'receipt')) add('documents', 'Upload at least one payment receipt');
  if (!deal.documents.some((x) => x.kind === 'agreement')) add('documents', 'Upload the agreement or booking form');
  const price = deal.dealType === 'rent' ? deal.monthlyRent : deal.agreedPrice;
  if (!price) add(deal.dealType === 'rent' ? 'monthlyRent' : 'agreedPrice', 'Enter the agreed amount');
  if (!deal.bookingAmount || deal.bookingAmount <= 0) add('bookingAmount', 'The booking amount must be more than 0');
  else if (deal.dealType === 'sale' && price && deal.bookingAmount > price) add('bookingAmount', 'The booking amount cannot exceed the agreed price');
  if (!deal.bookingDate) add('bookingDate', 'Enter the booking date');
  else if (deal.bookingDate > new Date() || deal.bookingDate < new Date(new Date(lead.createdAt).setHours(0, 0, 0, 0))) add('bookingDate', 'The booking date must be between the enquiry date and today');
  if (!deal.paymentMode) add('paymentMode', 'Choose the payment mode');
  if (errors.length) throw ApiError.validation(errors);

  const warnings = [];
  // Price deviation from the listed price (> 30% note, > 50% blocked).
  const listed = deal.propertyId ? await Property.findById(deal.propertyId).select('price') : null;
  const listedAmount = listed && listed.price && (deal.dealType === 'rent' ? listed.price.monthlyRent : listed.price.amount);
  if (listedAmount && price) {
    const dev = Math.abs(price - listedAmount) / listedAmount * 100;
    const notePct = await settings.get('deal.priceDeviationNotePercent');
    if (dev > 50) throw ApiError.validation([{ in: 'body', path: 'agreedPrice', message: `The price is ${Math.round(dev)}% away from the listed price; a manager must approve it` }], 'Price deviation above 50%');
    if (dev > notePct) {
      if (String(deal.justification || '').trim().length < 10) throw field('justification', `The price is ${Math.round(dev)}% away from the listed price; add a justification`);
      warnings.push({ code: 'PRICE_DEVIATION', message: `${Math.round(dev)}% from the listed price` });
    }
  }
  const cashLimit = toPaise(await settings.get('deal.cashWarnLimit'));
  if (deal.paymentMode === 'cash' && deal.bookingAmount > cashLimit) warnings.push({ code: 'CASH_269ST', message: `Cash above INR ${inr(cashLimit)} (Income Tax Act section 269ST); verification needs a note` });
  return warnings;
}

// Same file hash or same (mode, reference) in any other non-rejected deal (RE-H-05).
async function duplicateReceipts(deal) {
  const hashes = deal.documents.filter((x) => x.kind === 'receipt' && x.sha256).map((x) => x.sha256);
  const or = [];
  if (hashes.length) or.push({ 'documents.sha256': { $in: hashes } });
  if (deal.paymentReference && deal.paymentMode) or.push({ paymentMode: deal.paymentMode, paymentReference: deal.paymentReference });
  if (!or.length) return [];
  return Deal.find({ _id: { $ne: deal._id }, status: { $nin: ['rejected', 'cancelled'] }, $or: or }).select('dealNo status').lean();
}

async function submit(user, id, req) {
  const deal = await ownDeal(user, id);
  if (!EDITABLE.includes(deal.status)) throw ApiError.conflict(`A ${deal.status.replace('_', ' ')} deal cannot be submitted`, 'INVALID_TRANSITION');
  if (deal.status === 'returned' && deal.resubmissionCount >= MAX_RESUBMISSIONS) throw ApiError.conflict(`A deal can be resubmitted at most ${MAX_RESUBMISSIONS} times`, 'RESUBMISSION_LIMIT');
  const lead = await Lead.findById(deal.leadId);
  const warnings = await gates(deal, lead);
  const dups = await duplicateReceipts(deal);
  if (dups.length) throw ApiError.conflict(`This receipt is already used in deal ${dups.map((x) => x.dealNo).join(', ')}`, 'DUPLICATE_RECEIPT', { deals: dups.map((x) => x.dealNo) });
  const c = await computeCommission(deal);
  if (!c) throw ApiError.conflict('No commission agreement is in force for this listing on the booking date', 'NO_AGREEMENT');
  applyCommission(deal, c);
  if (deal.status === 'returned') deal.resubmissionCount += 1;
  move(deal, 'submitted', user._id, deal.resubmissionCount ? `Resubmission ${deal.resubmissionCount}` : 'Submitted');
  deal.submittedAt = new Date();
  deal.slaWarnedAt = undefined;
  deal.review = { ...((deal.review && deal.review.toObject && deal.review.toObject()) || {}), claimedBy: undefined, claimUntil: undefined };
  await deal.save();
  if (lead.stage !== 'booking') await common.changeStage(lead, 'booking', user._id, { system: true, note: `Deal ${deal.dealNo} submitted` });
  common.entry(lead, 'deal', user._id, { dealNo: deal.dealNo, status: 'submitted' });
  lead.lastActivityAt = new Date();
  await lead.save();
  await audit(req, { action: 'deal.submit', entityType: 'Deal', entityId: deal._id, after: { status: 'submitted', resubmissionCount: deal.resubmissionCount } });
  const [agent, target] = await Promise.all([User.findById(deal.agentId).select('name'), targetOf(deal)]);
  const vars = { dealNo: deal.dealNo, dealId: String(deal._id), propertyRef: propertyRef(target), agent: agent ? agent.name : '', slaHours: await settings.get('deal.verifySlaHours') };
  await notifyPermission('deals.verify', 'deal.submitted', vars, ['in_app', 'email']);
  for (const m of await teamManagers(deal.teamId)) await notifyUser({ user: m, event: 'deal.submitted', vars, channels: ['in_app'] });
  events.emit(events.EVENTS.DEAL_STATUS_CHANGED, { dealId: deal._id, status: 'submitted' });
  return { ...present(deal), warnings };
}

const cancelSchema = z.object({ reason: z.string().trim().min(5).max(500) });

async function cancel(user, id, body, req, { asAdmin = false } = {}) {
  const { reason } = cancelSchema.parse(body);
  const deal = asAdmin ? await adminDeal(user, id) : await ownDeal(user, id);
  if (!EDITABLE.includes(deal.status)) throw ApiError.conflict(`A ${deal.status.replace('_', ' ')} deal cannot be cancelled`, 'INVALID_TRANSITION');
  move(deal, 'cancelled', user._id, reason);
  deal.cancelReason = reason;
  await deal.save();
  const lead = await Lead.findById(deal.leadId);
  if (lead) {
    if (lead.stage === 'booking') await common.changeStage(lead, 'negotiation', user._id, { system: true, note: `Deal ${deal.dealNo} cancelled` });
    common.entry(lead, 'deal', user._id, { dealNo: deal.dealNo, status: 'cancelled', reason });
    await lead.save();
  }
  await audit(req, { action: 'deal.cancel', entityType: 'Deal', entityId: deal._id, reason });
  return present(deal);
}

async function listOwn(user, query) {
  const filter = await agentScope(user);
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  const { paginate } = require('../../core/http');
  return paginate(Deal, filter, query, { projection: '-statusHistory -review.idempotencyKey', populate: [{ path: 'propertyId', select: 'listingNo title slug' }, { path: 'projectId', select: 'projectNo name' }, { path: 'leadId', select: 'leadNo buyerLabel' }] });
}

async function agentDetail(user, id) {
  const deal = await ownDeal(user, id);
  const out = present(deal);
  const [lead, target, visits] = await Promise.all([
    Lead.findById(deal.leadId).select('leadNo stage buyer.name buyerLabel createdAt'),
    targetOf(deal),
    SiteVisit.find({ leadId: deal.leadId, status: 'completed' }).select('visitNo scheduledAt status outcome.result').lean(),
  ]);
  return { ...out, lead, target: summary(target), completedVisits: visits, checklist: await checklistFor(deal) };
}

// ---------------------------------------------------------------- admin

async function adminDeal(user, id) {
  if (!oid.safeParse(String(id)).success) throw ApiError.notFound('Deal not found');
  const deal = await Deal.findOne({ _id: id, ...(await adminScope(user)) });
  if (!deal) throw ApiError.notFound('Deal not found');
  return deal;
}

async function queue(user, query) {
  const filter = await adminScope(user);
  filter.status = { $in: query.status ? String(query.status).split(',') : ['submitted', 'under_review'] };
  if (query.agentId) filter.agentId = query.agentId;
  if (query.dealType) filter.dealType = query.dealType;
  if (query.q) filter.dealNo = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const { paginate } = require('../../core/http');
  const r = await paginate(Deal, filter, { sort: 'submittedAt', ...query }, {
    projection: 'dealNo status dealType agreedPrice monthlyRent bookingAmount paymentMode commissionAmount gstAmount submittedAt resubmissionCount review.claimedBy review.claimUntil agentId teamId propertyId projectId leadId createdAt',
    populate: [{ path: 'agentId', select: 'name' }, { path: 'propertyId', select: 'listingNo title' }, { path: 'projectId', select: 'projectNo name' }, { path: 'leadId', select: 'leadNo' }],
  });
  const slaHours = await settings.get('deal.verifySlaHours');
  r.items = r.items.map((d) => {
    const due = d.submittedAt ? new Date(new Date(d.submittedAt).getTime() + slaHours * 3600000) : null;
    return { ...d, slaDueAt: due, slaBreached: Boolean(due && due < new Date() && ['submitted', 'under_review'].includes(d.status)) };
  });
  return r;
}

async function checklistFor(deal) {
  const [visit, dups, cash] = await Promise.all([
    SiteVisit.exists({ leadId: deal.leadId, status: 'completed', ...(deal.propertyId ? { propertyId: deal.propertyId } : {}) }),
    duplicateReceipts(deal),
    settings.get('deal.cashWarnLimit'),
  ]);
  return {
    completedVisit: Boolean(visit),
    receipts: deal.documents.filter((x) => x.kind === 'receipt').length,
    agreements: deal.documents.filter((x) => x.kind === 'agreement').length,
    duplicateReceipts: dups.map((x) => x.dealNo),
    cashWarning: deal.paymentMode === 'cash' && deal.bookingAmount > toPaise(cash),
  };
}

async function adminDetail(user, id) {
  const deal = await adminDeal(user, id);
  const [lead, target, visits, agent, lister, recomputed, checklist, offer] = await Promise.all([
    Lead.findById(deal.leadId).select('leadNo stage buyer.name buyerLabel createdAt sources assignedTo teamId timeline'),
    targetOf(deal),
    SiteVisit.find({ leadId: deal.leadId }).select('visitNo scheduledAt status outcome propertyId').sort({ scheduledAt: 1 }).lean(),
    User.findById(deal.agentId).select('name email'),
    User.findById(deal.listerId).select('name listerType billing kyc.status'),
    computeCommission(deal),
    checklistFor(deal),
    deal.offerId ? Offer.findById(deal.offerId).select('offerNo status rounds').lean() : null,
  ]);
  const listed = target && target.price ? (deal.dealType === 'rent' ? target.price.monthlyRent : target.price.amount) : null;
  return {
    ...present(deal, { admin: true }), lead, target: summary(target), visits, agent, lister: lister && { _id: lister._id, name: lister.name, listerType: lister.listerType, billing: lister.billing, kycStatus: lister.kyc && lister.kyc.status },
    recomputedCommission: recomputed, checklist, offer, listedPrice: listed,
    priceDeviationPercent: listed && (deal.agreedPrice || deal.monthlyRent) ? Math.round(Math.abs((deal.dealType === 'rent' ? deal.monthlyRent : deal.agreedPrice) - listed) / listed * 1000) / 10 : null,
  };
}

async function documentUrl(user, id, docId, req) {
  const deal = await adminDeal(user, id);
  const doc = deal.documents.id(docId);
  if (!doc) throw ApiError.notFound('Document not found');
  const file = await storage.FileModel.findById(doc.fileId);
  if (!file) throw ApiError.notFound('File not found');
  await audit(req, { action: 'deal.document.view', entityType: 'Deal', entityId: deal._id, after: { docId } });
  return { url: storage.urlFor(file, 600), expiresInSec: 600, mime: file.mime, kind: doc.kind, label: doc.label };
}

async function claim(user, id, req) {
  const now = new Date();
  const deal = await adminDeal(user, id);
  const mine = deal.review && String(deal.review.claimedBy) === String(user._id);
  const lockedByOther = deal.status === 'under_review' && !mine && deal.review.claimUntil > now;
  if (lockedByOther) throw ApiError.conflict('Another admin is reviewing this deal', 'CLAIMED_BY_OTHER');
  if (!['submitted', 'under_review'].includes(deal.status)) throw ApiError.conflict(`A ${deal.status.replace('_', ' ')} deal cannot be claimed`, 'INVALID_TRANSITION');
  const r = await Deal.updateOne(
    { _id: deal._id, $or: [{ status: 'submitted' }, { status: 'under_review', 'review.claimUntil': { $lte: now } }, { status: 'under_review', 'review.claimedBy': user._id }] },
    { $set: { status: 'under_review', 'review.claimedBy': user._id, 'review.claimUntil': new Date(now.getTime() + LOCK_MS) }, ...(deal.status === 'submitted' ? { $push: { statusHistory: { from: 'submitted', to: 'under_review', actor: user._id, note: 'Claimed', at: now } } } : {}) },
  );
  if (!r.modifiedCount) throw ApiError.conflict('Another admin is reviewing this deal', 'CLAIMED_BY_OTHER');
  await audit(req, { action: 'deal.claim', entityType: 'Deal', entityId: deal._id });
  return { status: 'under_review', claimUntil: new Date(now.getTime() + LOCK_MS) };
}

async function release(user, id, req) {
  const deal = await adminDeal(user, id);
  if (deal.status !== 'under_review') throw ApiError.conflict('The deal is not under review', 'NOT_CLAIMED');
  const mine = String(deal.review.claimedBy) === String(user._id);
  if (!mine && deal.review.claimUntil > new Date() && user.role !== 'superadmin') throw ApiError.conflict('Another admin holds the lock', 'CLAIMED_BY_OTHER');
  move(deal, 'submitted', user._id, 'Released');
  deal.review.claimedBy = undefined;
  deal.review.claimUntil = undefined;
  await deal.save();
  await audit(req, { action: 'deal.release', entityType: 'Deal', entityId: deal._id });
  return { status: deal.status };
}

const decisionSchema = z.object({
  decision: z.enum(['verify', 'return', 'reject']),
  checklist: z.record(z.any()).optional(),
  comment: z.string().trim().max(2000).optional(),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(2000).optional(),
});

async function decide(user, id, body, req) {
  const d = decisionSchema.parse(body);
  const key = req.get && req.get('Idempotency-Key');
  const deal = await adminDeal(user, id);
  // Idempotency: a repeated verify with the same key returns the first result.
  if (deal.status === 'verified' && key && deal.review.idempotencyKey === key) return { ...present(deal, { admin: true }), replayed: true };
  if (deal.status !== 'under_review' || String(deal.review.claimedBy) !== String(user._id) || !(deal.review.claimUntil > new Date())) {
    throw ApiError.conflict('Claim the deal before deciding', 'NOT_CLAIMED');
  }
  if (d.decision === 'return') return returnDeal(user, deal, d, req);
  if (d.decision === 'reject') return rejectDeal(user, deal, d, req);
  return verify(user, deal, d, key, req);
}

async function backToNegotiation(deal, actor, note) {
  const lead = await Lead.findById(deal.leadId);
  if (!lead) return;
  if (lead.stage === 'booking') await common.changeStage(lead, 'negotiation', actor, { system: true, note });
  common.entry(lead, 'deal', actor, { dealNo: deal.dealNo, status: deal.status, note });
  await lead.save();
}

async function returnDeal(user, deal, d, req) {
  if (!d.comment || d.comment.length < 10) throw field('comment', 'Tell the agent what to correct (at least 10 characters)');
  move(deal, 'returned', user._id, d.comment);
  Object.assign(deal.review, { comment: d.comment, checklist: d.checklist, claimedBy: undefined, claimUntil: undefined });
  await deal.save();
  await backToNegotiation(deal, user._id, `Deal ${deal.dealNo} returned`);
  await audit(req, { action: 'deal.return', entityType: 'Deal', entityId: deal._id, reason: d.comment });
  const agent = await User.findById(deal.agentId);
  if (agent) await notifyUser({ user: agent, event: 'deal.returned', vars: { dealNo: deal.dealNo, dealId: String(deal._id), comment: d.comment }, channels: ['in_app', 'email'] });
  return present(deal, { admin: true });
}

async function rejectDeal(user, deal, d, req) {
  if (!d.reason || d.reason.length < 5) throw field('reason', 'A rejection reason is required');
  move(deal, 'rejected', user._id, d.reason);
  Object.assign(deal.review, { rejectReason: d.reason, comment: d.comment, checklist: d.checklist, claimedBy: undefined, claimUntil: undefined });
  await deal.save();
  await backToNegotiation(deal, user._id, `Deal ${deal.dealNo} rejected`);
  await audit(req, { action: 'deal.reject', entityType: 'Deal', entityId: deal._id, reason: d.reason });
  const vars = { dealNo: deal.dealNo, dealId: String(deal._id), reason: d.reason };
  const agent = await User.findById(deal.agentId);
  if (agent) await notifyUser({ user: agent, event: 'deal.rejected', vars, channels: ['in_app', 'email'] });
  for (const m of await teamManagers(deal.teamId)) await notifyUser({ user: m, event: 'deal.rejected', vars, channels: ['in_app'] });
  return present(deal, { admin: true });
}

// Listing status set by the system: an expired / paused / inactive listing is
// still marked sold on verification (edge case H), so the machine is bypassed
// with a history entry instead of assertTransition.
function systemStatus(doc, to, actor, note) {
  doc.statusHistory.push({ from: doc.status, to, actor, note, at: new Date() });
  doc.status = to;
}

function closedPayload(deal, lister, buyerUserId, target) {
  return {
    dealNo: deal.dealNo,
    dealType: deal.dealType,
    verified: true,
    verifiedAt: deal.review.verifiedAt.toISOString(),
    agreedPrice: toRupees(deal.dealType === 'rent' ? deal.monthlyRent * 12 : deal.agreedPrice),
    commissionPercent: deal.commissionPercent,
    commissionAmount: toRupees(deal.commissionAmount),
    currency: 'INR',
    buyer: { userRef: buyerUserId ? `u_${buyerUserId}` : null, referralCode: deal.referral && deal.referral.buyerReferralCode ? deal.referral.buyerReferralCode : null },
    lister: { userRef: `u_${deal.listerId}`, listerType: lister ? lister.listerType || null : null, referralCode: deal.referral && deal.referral.listerReferralCode ? deal.referral.listerReferralCode : null },
    agentRef: `s_${deal.agentId}`,
    propertyRef: target ? target.listingNo || target.projectNo : null,
    receiptsCount: deal.documents.filter((x) => x.kind === 'receipt').length,
  };
}

async function verify(user, deal, d, key, req) {
  const cashLimit = toPaise(await settings.get('deal.cashWarnLimit'));
  if (deal.paymentMode === 'cash' && deal.bookingAmount > cashLimit && String(d.note || '').trim().length < 10) {
    throw field('note', 'Cash above the 269ST limit: add a verification note');
  }
  const dups = await duplicateReceipts(deal);
  if (dups.length) throw ApiError.conflict(`This receipt is already used in deal ${dups.map((x) => x.dealNo).join(', ')}`, 'DUPLICATE_RECEIPT', { deals: dups.map((x) => x.dealNo) });
  const c = await computeCommission(deal);
  if (!c) throw ApiError.conflict('No commission agreement is in force for this listing on the booking date', 'NO_AGREEMENT');

  const receivables = require('../receivables/service');
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const dl = await Deal.findById(deal._id).session(session);
      if (dl.status !== 'under_review') throw ApiError.conflict(`The deal is ${dl.status.replace('_', ' ')}`, 'INVALID_TRANSITION');
      applyCommission(dl, c);
      const now = new Date();
      move(dl, 'verified', user._id, d.note || 'Verified');
      Object.assign(dl.review, { checklist: d.checklist, comment: d.comment, note: d.note, verifiedBy: user._id, verifiedAt: now, idempotencyKey: key || undefined, claimedBy: undefined, claimUntil: undefined });

      let target; let outcome;
      if (dl.projectId) {
        target = await Project.findById(dl.projectId).session(session);
        if (dl.unitConfigId) {
          const r = await Project.updateOne({ _id: dl.projectId, configurations: { $elemMatch: { _id: dl.unitConfigId, availableUnits: { $gt: 0 } } } },
            { $inc: { 'configurations.$.availableUnits': -1 }, $push: { inventoryLog: { configId: dl.unitConfigId, by: user._id, reason: `deal ${dl.dealNo}`, at: now } } }, { session });
          if (!r.modifiedCount) dl.statusHistory[dl.statusHistory.length - 1].note = `${d.note || 'Verified'} (inventory already 0)`;
        }
        outcome = 'booked';
      } else {
        target = await Property.findById(dl.propertyId).session(session);
        if (dl.dealType === 'sale') {
          if (target.status === 'sold' || await Deal.exists({ propertyId: dl.propertyId, status: 'verified', _id: { $ne: dl._id } }).session(session)) {
            throw ApiError.conflict('Property already sold', 'PROPERTY_SOLD');
          }
          systemStatus(target, 'sold', user._id, `Deal ${dl.dealNo} verified`);
          outcome = 'sold';
        } else {
          systemStatus(target, 'rented', user._id, `Deal ${dl.dealNo} verified`);
          outcome = 'rented';
        }
        await target.save({ session });
      }

      const lead = await Lead.findById(dl.leadId).session(session);
      await common.changeStage(lead, 'closed_won', user._id, { system: true, note: `Deal ${dl.dealNo} verified` });
      common.entry(lead, 'deal', user._id, { dealNo: dl.dealNo, status: 'verified' });
      await lead.save({ session });

      const rec = await receivables.createFromDeal(dl, { session });
      if (dl.agreementId) {
        await Agreement.updateOne({ _id: dl.agreementId }, { $inc: { 'totals.dealsCount': 1, 'totals.commissionVerified': dl.commissionAmount } }, { session });
      }
      const lister = await User.findById(dl.listerId).select('listerType').session(session);
      await outbox.record('deal.closed', closedPayload(dl, lister, lead.buyer && lead.buyer.userId, target), { session, aggregateId: dl._id });
      await dl.save({ session });
      await audit(req, { action: 'deal.verify', entityType: 'Deal', entityId: dl._id, after: { commissionAmount: dl.commissionAmount, gstAmount: dl.gstAmount, receivableNo: rec.receivableNo }, reason: d.note }, { session });
      result = { deal: dl, lead, target, outcome, receivable: rec };
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.conflict('Verification failed, retry', 'VERIFY_FAILED');
  } finally {
    await session.endSession();
  }
  await afterVerify(result);
  return { ...present(result.deal, { admin: true }), receivableNo: result.receivable.receivableNo, outcome: result.outcome };
}

// Notifications and queued side jobs, only after the commit.
async function afterVerify({ deal, lead, target, outcome, receivable }) {
  const jobs = require('../../core/jobs');
  if (deal.propertyId) jobs.enqueue('shortlist.unavailable', { propertyId: String(deal.propertyId), status: outcome }, { delayMs: 5000 }).catch(() => {});
  if (deal.projectId) {
    const p = await Project.findById(deal.projectId);
    if (p && p.status === 'live' && p.configurations.length && p.configurations.every((x) => x.availableUnits === 0)) {
      systemStatus(p, 'sold_out', deal.review.verifiedBy, 'All configurations sold out');
      await p.save();
    }
  }
  const ref = propertyRef(target);
  const vars = { dealNo: deal.dealNo, dealId: String(deal._id), commission: inr(deal.commissionAmount), propertyRef: ref, outcome };
  const [agent, lister] = await Promise.all([User.findById(deal.agentId), User.findById(deal.listerId)]);
  if (agent) await notifyUser({ user: agent, event: 'deal.verified', vars, channels: ['in_app', 'email'] });
  for (const m of await teamManagers(deal.teamId)) await notifyUser({ user: m, event: 'deal.verified', vars, channels: ['in_app'] });
  if (lister) await notifyUser({ user: lister, event: 'deal.verified_lister', vars: { propertyRef: ref, outcome }, channels: ['in_app', 'email'] });
  if (lead.buyer && lead.buyer.email) await sendNow({ channel: 'email', to: lead.buyer.email, event: 'deal.verified_buyer', vars: { name: lead.buyer.name, leadNo: lead.leadNo } }).catch(() => {});
  await notifyPermission('receivables.manage', 'receivable.created', { receivableNo: receivable.receivableNo, receivableId: String(receivable._id), dealNo: deal.dealNo, total: inr(receivable.totalDue) });
  // Other open leads on a sold sale listing: tell their agents (H1 step 3).
  if (outcome === 'sold' || outcome === 'rented') {
    const others = await Lead.find({ propertyId: deal.propertyId, _id: { $ne: lead._id }, stage: { $in: common.OPEN_STAGES }, assignedTo: { $ne: null } }).select('leadNo assignedTo');
    for (const o of others) {
      const u = await User.findById(o.assignedTo);
      if (u) await notifyUser({ user: u, event: 'deal.listing_sold', vars: { propertyRef: ref, leadNo: o.leadNo, leadId: String(o._id) } });
    }
  }
  events.emit(events.EVENTS.DEAL_VERIFIED, { dealId: deal._id, receivableId: receivable._id });
}

const reverseSchema = z.object({
  reason: z.string().trim().min(5).max(500),
  effectiveDate: z.coerce.date().optional(),
  leadOutcome: z.enum(['negotiation', 'closed_lost']).default('negotiation'),
  lostReason: z.string().trim().max(60).optional(),
});

async function reverse(user, id, body, req) {
  const d = reverseSchema.parse(body);
  const deal = await adminDeal(user, id);
  if (deal.status !== 'verified') throw ApiError.conflict('Only a verified deal can be reversed', 'INVALID_TRANSITION');
  const receivables = require('../receivables/service');
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const dl = await Deal.findById(deal._id).session(session);
      if (dl.status !== 'verified') throw ApiError.conflict('Only a verified deal can be reversed', 'INVALID_TRANSITION');
      const now = new Date();
      move(dl, 'reversed', user._id, d.reason);
      dl.reversal = { reason: d.reason, by: user._id, at: now, effectiveDate: d.effectiveDate || now, leadOutcome: d.leadOutcome };
      const effects = [];

      let target;
      if (dl.projectId) {
        target = await Project.findById(dl.projectId).session(session);
        if (dl.unitConfigId) {
          await Project.updateOne({ _id: dl.projectId, 'configurations._id': dl.unitConfigId },
            { $inc: { 'configurations.$.availableUnits': 1 }, $push: { inventoryLog: { configId: dl.unitConfigId, by: user._id, reason: `deal ${dl.dealNo} reversed`, at: now } } }, { session });
          effects.push('Project inventory +1');
        }
        if (target.status === 'sold_out') { systemStatus(target, 'live', user._id, `Deal ${dl.dealNo} reversed`); await target.save({ session }); }
      } else {
        target = await Property.findById(dl.propertyId).session(session);
        if (['sold', 'rented'].includes(target.status)) {
          const to = target.expiresAt && target.expiresAt > now ? 'live' : 'expired';
          systemStatus(target, to, user._id, `Deal ${dl.dealNo} reversed`);
          await target.save({ session });
          effects.push(`Listing back to ${to}`);
        }
      }

      const lead = await Lead.findById(dl.leadId).session(session);
      // closed_won -> negotiation (-> closed_lost when chosen), each step on the timeline.
      await common.changeStage(lead, 'negotiation', user._id, { system: true, note: `Deal ${dl.dealNo} reversed` });
      lead.closedAt = undefined;
      if (d.leadOutcome === 'closed_lost') await common.changeStage(lead, 'closed_lost', user._id, { system: true, lostReason: d.lostReason || 'deal_reversed', lostNote: d.reason });
      common.entry(lead, 'deal', user._id, { dealNo: dl.dealNo, status: 'reversed', reason: d.reason });
      await lead.save({ session });

      const rec = await receivables.onDealReversed(dl, d.reason, user._id, { session });
      if (rec) effects.push(`Receivable ${rec.receivableNo} ${rec.status}`);
      if (dl.agreementId) await Agreement.updateOne({ _id: dl.agreementId }, { $inc: { 'totals.dealsCount': -1, 'totals.commissionVerified': -(dl.commissionAmount || 0) } }, { session });
      await outbox.record('deal.reversed', { dealNo: dl.dealNo, reason: d.reason, reversedAt: now.toISOString(), effectiveDate: (d.effectiveDate || now).toISOString(), buyer: { referralCode: (dl.referral && dl.referral.buyerReferralCode) || null }, lister: { referralCode: (dl.referral && dl.referral.listerReferralCode) || null } }, { session, aggregateId: dl._id });
      await dl.save({ session });
      await audit(req, { action: 'deal.reverse', entityType: 'Deal', entityId: dl._id, reason: d.reason, after: { effects } }, { session });
      result = { deal: dl, target, effects };
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.conflict('Reversal failed, retry', 'REVERSE_FAILED');
  } finally {
    await session.endSession();
  }
  const { deal: dl, target, effects } = result;
  const vars = { dealNo: dl.dealNo, propertyRef: propertyRef(target), reason: d.reason, effects: effects.join('. ') };
  const [agent, lister] = await Promise.all([User.findById(dl.agentId), User.findById(dl.listerId)]);
  if (agent) await notifyUser({ user: agent, event: 'deal.reversed', vars: { ...vars, link: `/agent/deals/${dl._id}` }, channels: ['in_app', 'email'] });
  for (const m of await teamManagers(dl.teamId)) await notifyUser({ user: m, event: 'deal.reversed', vars: { ...vars, link: `/admin/deals/${dl._id}` } });
  if (lister) await notifyUser({ user: lister, event: 'deal.reversed', vars: { ...vars, effects: '', link: '/lister/listings' }, channels: ['in_app', 'email'] });
  events.emit(events.EVENTS.DEAL_REVERSED, { dealId: dl._id });
  return { ...present(dl, { admin: true }), effects };
}

// ---------------------------------------------------------------- jobs

// Locks past their 30 minutes go back to the queue.
async function expireClaims(now = new Date()) {
  const stale = await Deal.find({ status: 'under_review', 'review.claimUntil': { $lte: now } });
  for (const dl of stale) {
    history(dl, 'submitted', undefined, 'Claim expired');
    dl.review.claimedBy = undefined;
    dl.review.claimUntil = undefined;
    await dl.save();
  }
  return stale.length;
}

// Deals within 12 h of the 72 h verification SLA (deal.verify_sla_warning).
async function slaWarnings(now = new Date()) {
  const hours = await settings.get('deal.verifySlaHours');
  const near = await Deal.find({ status: { $in: ['submitted', 'under_review'] }, slaWarnedAt: null, submittedAt: { $lte: new Date(now.getTime() - Math.max(0, hours - 12) * 3600000) } }).select('dealNo');
  if (!near.length) return 0;
  await notifyPermission('deals.verify', 'deal.verify_sla_warning', { count: near.length, slaHours: hours, list: near.map((x) => x.dealNo).join(', ') });
  await Deal.updateMany({ _id: { $in: near.map((x) => x._id) } }, { $set: { slaWarnedAt: now } });
  return near.length;
}

// ---------------------------------------------------------------- shared

async function teamManagers(teamId) {
  if (!teamId) return [];
  const team = await Team.findById(teamId).select('managerIds').lean();
  if (!team || !team.managerIds || !team.managerIds.length) return [];
  return User.find({ _id: { $in: team.managerIds } });
}

async function targetOf(deal) {
  if (deal.projectId) return Project.findById(deal.projectId).select('projectNo name status configurations.name configurations._id configurations.availableUnits location.city').lean();
  return Property.findById(deal.propertyId).select('listingNo title slug status purpose price location.city location.locality expiresAt').lean();
}

function summary(t) {
  if (!t) return null;
  return t.projectNo
    ? { kind: 'project', _id: t._id, ref: t.projectNo, name: t.name, status: t.status, city: t.location && t.location.city, configurations: t.configurations }
    : { kind: 'property', _id: t._id, ref: t.listingNo, title: t.title, slug: t.slug, status: t.status, purpose: t.purpose, price: t.price, city: t.location && t.location.city, locality: t.location && t.location.locality };
}

function present(deal, { admin = false } = {}) {
  const o = deal.toObject ? deal.toObject() : { ...deal };
  if (o.review) delete o.review.idempotencyKey;
  if (!admin && o.review) { delete o.review.checklist; delete o.review.claimedBy; delete o.review.claimUntil; }
  o.documents = (o.documents || []).map((x) => ({ _id: x._id, kind: x.kind, label: x.label, reference: x.reference, at: x.at, fileId: x.fileId }));
  return o;
}

module.exports = {
  create, edit, addDocument, removeDocument, submit, cancel, listOwn, agentDetail,
  queue, adminDetail, documentUrl, claim, release, decide, reverse,
  expireClaims, slaWarnings, computeCommission, previewCommission, duplicateReceipts, teamManagers, OPEN,
};
