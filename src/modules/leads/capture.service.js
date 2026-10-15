// Module C capture (workflow C1, RE-C-01/03/04, RE-E-20): guest phone OTP,
// rate limits, seeker rules, duplicate merge within 7 days, lead creation,
// routing and acknowledgements. Lister data never reaches the buyer and buyer
// data never reaches the lister ("Buyer N").
const { z } = require('zod');
const { Lead, BuyerContact, SiteVisit } = require('./models');
const { Property } = require('../listings/models');
const { User, Consent } = require('../auth/models');
const authV = require('../auth/validators');
const otpService = require('../auth/services/otp.service');
const jwt = require('../../core/security/jwt');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');
const { notifyUser, sendNow } = require('../notifications/service');
const common = require('./common');
const slots = require('./slots.service');
const seeker = require('../kyc/seeker.service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const utmSchema = z.object({ source: z.string().max(60).optional(), medium: z.string().max(60).optional(), campaign: z.string().max(80).optional() }).optional();

// ---------------------------------------------------------------- guest OTP

async function sendOtp(body) {
  const { phone, email } = z.object({ phone: authV.phone, email: authV.email.optional() }).parse(body);
  if ((await seeker.restriction(phone)) === 'blocked') throw ApiError.forbidden('Please call our hotline to enquire', 'SEEKER_BLOCKED');
  const indian = phone.startsWith('+91');
  if (!indian && !email) throw ApiError.validation([{ in: 'body', path: 'email', message: 'Add your email to receive the code' }]);
  const r = await otpService.issue({ target: phone, channel: indian ? 'sms' : 'email', purpose: 'guest_enquiry', fallbackEmail: email });
  return { sentTo: r.channelUsed === 'email' ? 'email' : 'sms', expiresInMin: 5 };
}

async function verifyOtp(body) {
  const { phone, code } = z.object({ phone: authV.phone, code: authV.code6 }).parse(body);
  await otpService.verify({ target: phone, purpose: 'guest_enquiry', code });
  return { otpToken: jwt.signGuest(phone), expiresInMin: 10 };
}

function guestPhone(otpToken) {
  try { return jwt.verify(otpToken, 'guest').sub; } catch { throw ApiError.unauthenticated('Verify your phone again', 'OTP_TOKEN_INVALID'); }
}

// ---------------------------------------------------------------- limits

async function bump(key, limit, windowMs, message) {
  const { Counter } = require('../../core/counters');
  const bucket = `${key}:${Math.floor(Date.now() / windowMs)}`;
  const doc = await Counter.findOneAndUpdate({ _id: bucket }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  if (doc.seq > limit) throw new ApiError(429, 'RATE_LIMITED', message);
}

async function enforceLimits(phone, ip, restriction) {
  const s = await settings.all();
  const perDay = restriction === 'throttled' ? s['seeker.throttlePerDay'] : s['lead.maxEnquiriesPerPhonePerDay'];
  await bump(`enq:phone:${phone}`, perDay, 86400000, 'You have sent many enquiries today. Our team will call you, or call the hotline.');
  if (ip) await bump(`enq:ip:${ip}`, s['lead.maxEnquiriesPerIpPerHour'], 3600000, 'Too many enquiries from this network. Please try again later.');
}

// ---------------------------------------------------------------- buyer identity

async function buyerFor(user, d) {
  if (user) {
    if (user.role !== 'buyer' && user.role !== 'lister') throw ApiError.forbidden('Staff cannot enquire as buyers', 'NOT_A_BUYER');
    const contact = await BuyerContact.findOneAndUpdate({ phone: user.phone }, { $set: { name: user.name, email: user.email, userId: user._id }, $setOnInsert: { phone: user.phone, referralCode: user.referredBy } }, { upsert: true, new: true });
    return { contact, phone: user.phone, name: user.name, email: user.email, userId: user._id, referralCode: user.referredBy };
  }
  const s = await settings.all();
  let phone;
  if (d.trustedPhone) phone = d.trustedPhone; // verified by the channel itself (WhatsApp sender), never from a request body
  else if (d.otpToken) phone = guestPhone(d.otpToken);
  else if (s['lead.requireOtpForGuest']) throw ApiError.unauthenticated('Verify your phone number first', 'OTP_REQUIRED');
  else phone = authV.phone.parse(d.phone);
  const contact = await BuyerContact.findOneAndUpdate({ phone }, { $set: { ...(d.name ? { name: d.name } : {}), ...(d.email ? { email: d.email } : {}) }, $setOnInsert: { phone, referralCode: d.referralCode } }, { upsert: true, new: true });
  return { contact, phone, name: d.name || contact.name, email: d.email || contact.email, referralCode: d.referralCode || contact.referralCode };
}

async function recordConsent(buyer, d, req) {
  const noticeVersion = await settings.get('privacy.noticeVersion');
  const subject = buyer.userId ? { subjectType: 'user', subjectId: buyer.userId } : { subjectType: 'buyer_contact', subjectId: buyer.contact._id };
  await Consent.create({ ...subject, purpose: 'sales_contact', noticeVersion, source: d.consentSource || 'enquiry', ip: req.ip }).catch(() => {});
  if (d.whatsappOptIn) await Consent.create({ ...subject, purpose: 'whatsapp_updates', noticeVersion, source: 'enquiry', ip: req.ip }).catch(() => {});
}

async function acknowledge(lead, buyer, extra = {}) {
  const vars = { leadNo: lead.leadNo, name: buyer.name || 'there', ...extra };
  if (buyer.userId) {
    const u = await User.findById(buyer.userId);
    if (u) await notifyUser({ user: u, event: 'lead.created', channels: ['in_app', 'email', 'sms'], vars });
    return;
  }
  await sendNow({ channel: buyer.phone.startsWith('+91') ? 'sms' : 'email', to: buyer.phone.startsWith('+91') ? buyer.phone : buyer.email, event: 'lead.created', vars, fallbackEmail: buyer.email }).catch(() => {});
}

// ---------------------------------------------------------------- enquiry (C1)

const enquirySchema = z.object({
  type: z.enum(['enquiry', 'callback', 'site_visit', 'best_price']).default('enquiry'),
  propertyId: oid.optional(),
  projectId: oid.optional(),
  unitConfigId: oid.optional(),
  name: z.string().trim().min(2).max(80).optional(),
  email: authV.email.optional(),
  phone: z.string().optional(),
  otpToken: z.string().optional(),
  message: z.string().trim().max(1000).optional(),
  preferredSlot: z.coerce.date().optional(),
  consent: z.literal(true, { errorMap: () => ({ message: 'Please agree to be contacted by our sales team' }) }),
  whatsappOptIn: z.boolean().default(false),
  referralCode: z.string().trim().toUpperCase().max(20).optional(),
  utm: utmSchema,
  // Form extras (RE-S-PUB-06): stored as fields, not folded into the message.
  callbackWindow: z.enum(['anytime', 'morning', 'afternoon', 'evening']).optional(),
  visitors: z.number().int().min(1).max(10).optional(),
  pickupNeeded: z.boolean().optional(),
  budgetMax: z.number().min(0).optional(),
  timeline: z.enum(['immediate', '1_3_months', '3_6_months', 'later']).optional(),
  loanNeeded: z.boolean().optional(),
}).refine((d) => d.propertyId || d.projectId, { path: ['propertyId'], message: 'Choose a property or project' });

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
// Requirement fields and enquiry meta given in the form (only those sent).
const formRequirement = (d) => defined({ budgetMax: d.budgetMax, timeline: d.timeline, loanNeeded: d.loanNeeded });
const formMeta = (d) => defined({ callbackWindow: d.callbackWindow, visitors: d.visitors, pickupNeeded: d.pickupNeeded });

// opts.trustedPhone / opts.source: internal channels (WhatsApp inbound, RE-B-14 / RE-K-08)
// whose sender number is already verified; no OTP and no per-IP limit.
async function enquiry(body, req, opts = {}) {
  const parsed = enquirySchema.parse(body);
  const d = { ...parsed, type: opts.source || parsed.type, consentSource: opts.source === 'whatsapp' ? 'whatsapp' : 'enquiry' };
  let target;
  let listerId;
  let ctx;
  if (d.propertyId) {
    target = await Property.findOne({ _id: d.propertyId, status: 'live', deletedAt: null }).lean();
    if (!target) throw ApiError.notFound('This property is no longer available');
    listerId = target.listerId;
    const lister = await User.findById(listerId).select('listerType').lean();
    ctx = { city: target.location.city, locality: target.location.locality, purpose: target.purpose, category: target.category, type: target.type, budget: Math.round(((target.price.amount || target.price.monthlyRent) || 0) / 100), listerType: lister && lister.listerType };
  } else {
    const { Project } = require('../projects/models');
    target = await Project.findOne({ _id: d.projectId, status: { $in: ['live', 'sold_out'] } }).lean();
    if (!target) throw ApiError.notFound('This project is not available');
    listerId = target.builderId;
    ctx = { city: target.location.city, locality: target.location.locality, purpose: 'sale', category: 'residential', listerType: 'builder' };
  }
  const buyer = await buyerFor(opts.trustedPhone ? null : req.user, opts.trustedPhone ? { ...d, trustedPhone: opts.trustedPhone } : d);
  if (req.user && String(req.user._id) === String(listerId)) throw ApiError.conflict('You cannot enquire on your own listing', 'SELF_ENQUIRY');
  const restriction = await seeker.restriction(buyer.phone);
  if (restriction === 'blocked') throw ApiError.forbidden('Please call our hotline to enquire', 'SEEKER_BLOCKED');
  await enforceLimits(buyer.phone, opts.trustedPhone ? null : req.ip, restriction);
  ctx.source = d.type;
  const s = await settings.all();

  // Duplicate merge (RE-C-03): same phone + same property / project within 7 days.
  const since = new Date(Date.now() - s['lead.dedupeDays'] * 86400000);
  const key = d.propertyId ? { propertyId: d.propertyId } : { projectId: d.projectId };
  const existing = await Lead.findOne({ 'buyer.phone': buyer.phone, ...key, stage: { $in: common.OPEN_STAGES }, createdAt: { $gte: since } });
  let visit;
  if (existing) {
    if (!existing.sources.includes(d.type)) existing.sources.push(d.type);
    if (['site_visit', 'best_price'].includes(d.type)) existing.priority = 'hot';
    const reqExtra = formRequirement(d);
    const meta = formMeta(d);
    if (Object.keys(reqExtra).length) existing.requirement = { ...(existing.requirement ? existing.requirement.toObject() : {}), ...reqExtra };
    if (Object.keys(meta).length) existing.enquiry = { ...(existing.enquiry ? existing.enquiry.toObject() : {}), ...meta };
    common.entry(existing, 'merged', null, { type: d.type, message: d.message, ...reqExtra, ...meta });
    if (d.type === 'site_visit') visit = await requestVisit(existing, target, listerId, d.preferredSlot, { pickupNeeded: d.pickupNeeded });
    await existing.save();
    if (existing.assignedTo) {
      const agent = await User.findById(existing.assignedTo);
      if (agent) await notifyUser({ user: agent, event: 'lead.merged', vars: { leadNo: existing.leadNo, leadId: String(existing._id) } });
    }
    return { leadNo: existing.leadNo, merged: true, visitNo: visit && visit.visitNo };
  }
  // A buyer may hold at most 20 open leads; beyond that, the manager queue (possible spam).
  const openCount = await Lead.countDocuments({ 'buyer.phone': buyer.phone, stage: { $in: common.OPEN_STAGES } });
  const lead = new Lead({
    leadNo: await counters.leadNo(),
    buyer: { contactId: buyer.contact._id, userId: buyer.userId, name: buyer.name, phone: buyer.phone, email: buyer.email },
    ...(d.propertyId ? { propertyId: d.propertyId } : { projectId: d.projectId, unitConfigId: d.unitConfigId }),
    sources: [d.type], priority: ['site_visit', 'best_price'].includes(d.type) ? 'hot' : 'warm',
    requirement: { purpose: ctx.purpose, city: ctx.city, notes: d.message, ...formRequirement(d) },
    enquiry: formMeta(d),
    buyerLabel: await common.nextBuyerLabel(d.propertyId || d.projectId),
    referralCode: buyer.referralCode, consentAt: new Date(), whatsappOptIn: d.whatsappOptIn, utm: d.utm,
    throttled: restriction === 'throttled' || openCount >= 20,
  });
  common.entry(lead, 'created', buyer.userId, { type: d.type, message: d.message });
  await common.route(lead, ctx);
  await lead.save();
  if (d.type === 'site_visit') visit = await requestVisit(lead, target, listerId, d.preferredSlot, { pickupNeeded: d.pickupNeeded });
  if (d.propertyId) await Property.updateOne({ _id: d.propertyId }, { $inc: { 'stats.enquiries': 1 } });
  await recordConsent(buyer, d, req);
  await acknowledge(lead, buyer, { listingNo: target.listingNo || target.projectNo });
  const lister = await User.findById(listerId);
  if (lister) await notifyUser({ user: lister, event: 'lead.lister_new', vars: { listingNo: target.listingNo || target.projectNo, buyerLabel: lead.buyerLabel } });
  await seeker.evaluate(buyer.phone);
  return { leadNo: lead.leadNo, merged: false, visitNo: visit && visit.visitNo };
}

async function requestVisit(lead, target, listerId, preferredSlot, { pickupNeeded } = {}) {
  if (!target.listingNo) return null; // project visits are arranged by the agent
  if (preferredSlot) {
    const c = await slots.checkSlot(preferredSlot, { listerId, propertyId: target._id });
    if (!c.ok) throw ApiError.validation([{ in: 'body', path: 'preferredSlot', message: c.reason }]);
  }
  if (await SiteVisit.exists({ leadId: lead._id, status: { $in: ['requested', 'scheduled', 'confirmed'] } })) return null;
  const v = await SiteVisit.create({ visitNo: await counters.visitNo(), leadId: lead._id, propertyId: target._id, agentId: lead.assignedTo, scheduledAt: preferredSlot || new Date(Date.now() + 86400000), requestedSlot: preferredSlot, status: 'requested', ...(pickupNeeded ? { pickup: { needed: true } } : {}) });
  common.entry(lead, 'visit', null, { visitNo: v.visitNo, status: 'requested', at: preferredSlot });
  await lead.save();
  return v;
}

// ---------------------------------------------------------------- contact form and requirement (RE-E-20)

async function contactForm(body, req) {
  const d = z.object({ name: z.string().trim().min(2).max(80), email: authV.email.optional(), phone: z.string().optional(), otpToken: z.string().optional(), message: z.string().trim().min(5).max(2000), consent: z.literal(true), city: z.string().max(60).optional(), referralCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,20}$/).optional() }).parse(body);
  const buyer = await buyerFor(req.user, d);
  const restriction = await seeker.restriction(buyer.phone);
  if (restriction === 'blocked') throw ApiError.forbidden('Please call our hotline', 'SEEKER_BLOCKED');
  await enforceLimits(buyer.phone, req.ip, restriction);
  const lead = new Lead({ leadNo: await counters.leadNo(), buyer: { contactId: buyer.contact._id, userId: buyer.userId, name: buyer.name, phone: buyer.phone, email: buyer.email }, sources: ['contact_form'], requirement: { city: d.city, notes: d.message }, referralCode: buyer.referralCode, consentAt: new Date(), throttled: restriction === 'throttled' });
  common.entry(lead, 'created', buyer.userId, { type: 'contact_form', message: d.message });
  await common.route(lead, { city: d.city, source: 'contact_form' });
  await lead.save();
  await recordConsent(buyer, d, req);
  await acknowledge(lead, buyer);
  return { leadNo: lead.leadNo };
}

const requirementSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(), email: authV.email.optional(), phone: z.string().optional(), otpToken: z.string().optional(),
  city: z.string().trim().min(2).max(60), localities: z.array(z.string().max(60)).max(10).default([]),
  purpose: z.enum(['sale', 'rent']), category: z.enum(['residential', 'commercial', 'land']).optional(), types: z.array(z.string()).max(10).default([]),
  bhk: z.array(z.number().int().min(0).max(10)).max(6).default([]), budgetMin: z.number().min(0).optional(), budgetMax: z.number().min(0).optional(),
  timeline: z.enum(['immediate', '1_3_months', '3_6_months', 'later']).optional(), loanNeeded: z.boolean().optional(), notes: z.string().trim().max(1000).optional(),
  consent: z.literal(true), alertMe: z.boolean().default(false), utm: utmSchema,
  referralCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,20}$/).optional(), // captured ?ref= link (RE-N-01)
});

async function requirement(body, req) {
  const d = requirementSchema.parse(body);
  const buyer = await buyerFor(req.user, d);
  const restriction = await seeker.restriction(buyer.phone);
  if (restriction === 'blocked') throw ApiError.forbidden('Please call our hotline', 'SEEKER_BLOCKED');
  await enforceLimits(buyer.phone, req.ip, restriction);
  const s = await settings.all();
  const since = new Date(Date.now() - s['lead.dedupeDays'] * 86400000);
  const req2 = { purpose: d.purpose, city: d.city, category: d.category, types: d.types, localities: d.localities, bhk: d.bhk, budgetMin: d.budgetMin, budgetMax: d.budgetMax, timeline: d.timeline, loanNeeded: d.loanNeeded, notes: d.notes };
  let lead = await Lead.findOne({ 'buyer.phone': buyer.phone, propertyId: null, projectId: null, 'requirement.city': d.city, 'requirement.purpose': d.purpose, sources: 'requirement', stage: { $in: common.OPEN_STAGES }, createdAt: { $gte: since } });
  let merged = false;
  if (lead) {
    lead.requirement = { ...lead.requirement.toObject(), ...req2 };
    common.entry(lead, 'merged', buyer.userId, { type: 'requirement' });
    merged = true;
  } else {
    lead = new Lead({ leadNo: await counters.leadNo(), buyer: { contactId: buyer.contact._id, userId: buyer.userId, name: buyer.name, phone: buyer.phone, email: buyer.email }, sources: ['requirement'], priority: 'warm', requirement: req2, referralCode: buyer.referralCode, consentAt: new Date(), utm: d.utm, throttled: restriction === 'throttled' });
    common.entry(lead, 'created', buyer.userId, { type: 'requirement' });
    await common.route(lead, { city: d.city, localities: d.localities, purpose: d.purpose, category: d.category, budget: d.budgetMax || d.budgetMin, source: 'requirement' });
  }
  await lead.save();
  if (!merged) { await recordConsent(buyer, d, req); await acknowledge(lead, buyer); }
  let savedSearchId;
  if (d.alertMe && req.user) {
    const search = require('../search/service');
    const filters = { purpose: d.purpose, city: d.city, ...(d.localities.length ? { localities: d.localities.join(',') } : {}), ...(d.bhk.length ? { bhk: d.bhk.join(',') } : {}), ...(d.budgetMax ? { maxPrice: d.budgetMax } : {}) };
    try { savedSearchId = (await search.createSaved(req.user, { name: `Requirement ${lead.leadNo}`, filters, frequency: 'daily' }))._id; } catch { /* 10-search cap reached */ }
  }
  return { leadNo: lead.leadNo, merged, savedSearchId };
}

module.exports = { sendOtp, verifyOtp, enquiry, contactForm, requirement, requestVisit, buyerFor };
