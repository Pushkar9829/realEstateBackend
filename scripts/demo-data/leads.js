// Leads through the real capture service (guest OTP token, consent, routing,
// "Buyer N" labels, acknowledgements) and the agent / manager / lister / buyer
// services: call logs, notes, follow-ups, site visits (requested, scheduled,
// confirmed, rescheduled, cancelled, no-show, completed + feedback), offers
// (open, countered, accepted, declined, withdrawn, expired), masked lister
// updates, reassignment requests, merge / recycle, seeker flags and reveals.
// A lead is matched by buyer phone + property / project (or requirement source).
const jwt = require('../../src/core/security/jwt');
const { Lead, SiteVisit, Offer, FollowUp, ListerUpdate, BuyerContact } = require('../../src/modules/leads/models');
const { Property } = require('../../src/modules/listings/models');
const { User } = require('../../src/modules/auth/models');
const { Team } = require('../../src/modules/teams/models');
const { SeekerFlag } = require('../../src/modules/kyc/models');
const { ContactReveal } = require('../../src/modules/reports/models');
const Job = require('../../src/core/jobs/Job.model');
const capture = require('../../src/modules/leads/capture.service');
const agentSvc = require('../../src/modules/leads/agent.service');
const adminSvc = require('../../src/modules/leads/admin.service');
const listerSvc = require('../../src/modules/leads/lister.service');
const buyerSvc = require('../../src/modules/leads/buyer.service');
const slots = require('../../src/modules/leads/slots.service');
const leadJobs = require('../../src/modules/leads/jobs');
const seeker = require('../../src/modules/kyc/seeker.service');
const reveal = require('../../src/modules/masking/reveal.service');
const account = require('../../src/modules/auth/services/account.service');
const media = require('./media');
const { fakeReq, step, col, istAt, daysAgo, DAY, HOUR } = require('./context');

const u = (email) => User.findOne({ email }).select('+permissions');
const ORDER = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_done', 'negotiation', 'booking', 'closed_won'];
const idx = (s) => ORDER.indexOf(s);
let slotSeq = 0;

// ---------------------------------------------------------------- slots

async function findSlot(agentId, p, { fromDay = 1 } = {}) {
  slotSeq += 1;
  const hours = [10, 11, 12, 14, 15, 16, 17];
  for (let d = fromDay; d < fromDay + 30; d += 1) {
    for (let k = 0; k < hours.length * 2; k += 1) {
      const slot = (k + slotSeq) % (hours.length * 2);
      const at = istAt(d, hours[Math.floor(slot / 2)], slot % 2 ? 30 : 0);
      const c = await slots.checkSlot(at, { listerId: p.listerId, propertyId: p._id });
      if (!c.ok) continue;
      const clash = await SiteVisit.exists({ agentId, status: { $in: ['scheduled', 'confirmed'] }, scheduledAt: { $gt: new Date(at.getTime() - 60 * 60000), $lt: new Date(at.getTime() + 60 * 60000) } });
      if (!clash) return at;
    }
  }
  throw new Error(`No free visit slot for ${p.listingNo}`);
}

const pastSlot = (n) => istAt(-(1 + (n % 4)), 10 + (n % 7), n % 2 ? 30 : 0);

// ---------------------------------------------------------------- capture + assignment

function targetOf(ctx, spec) {
  if (spec.project) {
    const pr = ctx.projects[spec.project];
    return { project: pr, config: pr.configurations.find((c) => c.name === spec.config) };
  }
  return { property: ctx.listings[spec.on] };
}

async function findLead(spec, phone, t) {
  if (spec.kind === 'requirement' || spec.kind === 'contact') return Lead.findOne({ 'buyer.phone': phone, sources: spec.kind === 'requirement' ? 'requirement' : 'contact_form' });
  if (spec.kind === 'manual') return Lead.findOne({ 'buyer.phone': phone, sources: spec.source });
  return Lead.findOne({ 'buyer.phone': phone, ...(t.project ? { projectId: t.project._id } : { propertyId: t.property._id }), recycledFrom: null });
}

async function createLead(ctx, spec, buyerUser, guest, t) {
  const req = fakeReq(buyerUser || null);
  const who = buyerUser ? {} : { name: guest.name, email: guest.email, otpToken: jwt.signGuest(guest.phone) };
  if (spec.kind === 'requirement') return capture.requirement({ ...who, consent: true, ...spec.requirement }, req);
  if (spec.kind === 'contact') return capture.contactForm({ ...who, consent: true, message: spec.message, city: spec.city }, req);
  if (spec.kind === 'manual') {
    const agent = await u(spec.agent);
    return agentSvc.manualLead(agent, { source: spec.source, name: guest.name, phone: guest.phone, email: guest.email, propertyId: t.property && String(t.property._id), referralCode: spec.referralCode, notes: spec.message, requirement: spec.requirement, consent: true }, fakeReq(agent));
  }
  const body = {
    type: spec.source || 'enquiry', ...who, consent: true, whatsappOptIn: Boolean(spec.whatsapp), message: spec.message,
    ...(t.project ? { projectId: String(t.project._id), unitConfigId: String(t.config._id) } : { propertyId: String(t.property._id) }),
    ...(spec.form || {}), utm: spec.utm, referralCode: spec.referralCode,
  };
  if (spec.source === 'site_visit') body.preferredSlot = await findSlot(null, t.property, { fromDay: 2 });
  return capture.enquiry(body, req);
}

async function ensureLead(ctx, spec) {
  const buyerUser = spec.buyer ? await u(spec.buyer) : null;
  const guest = spec.guest;
  const phone = buyerUser ? buyerUser.phone : guest.phone;
  const t = spec.kind && spec.kind !== 'manual' ? {} : targetOf(ctx, spec);
  if (spec.kind === 'manual' && spec.on) Object.assign(t, targetOf(ctx, spec));
  if (spec.recycle) { // the original may be anonymised by the retention demo (phone cleared): find it through its successor
    const re = await Lead.findOne({ recycledFrom: { $ne: null }, 'buyer.phone': phone });
    if (re) { ctx.leads[spec.key] = await Lead.findById(re.recycledFrom); return ctx.leads[spec.key]; }
  }
  let lead = await findLead(spec, phone, t);
  if (!lead) {
    await createLead(ctx, spec, buyerUser, guest, t);
    lead = await findLead(spec, phone, t);
  }
  if (spec.agent && spec.agent !== 'auto' && spec.kind !== 'manual') {
    const agent = await u(spec.agent);
    const handedOver = (lead.reassignRequests || []).some((r) => r.status === 'approved'); // a manager moved it on purpose
    if (!handedOver && String(lead.assignedTo) !== String(agent._id) && !lead.mergedInto && !['closed_won', 'closed_lost'].includes(lead.stage)) {
      await adminSvc.assign(ctx.users.superadmin, String(lead._id), { agentId: String(agent._id), reason: spec.assignNote || 'Assigned by manager for the demo' }, fakeReq(ctx.users.superadmin));
      lead = await Lead.findById(lead._id);
    }
  }
  ctx.leads[spec.key] = lead;
  return lead;
}

// ---------------------------------------------------------------- progress helpers

async function agentOf(lead) { return User.findById(lead.assignedTo).select('+permissions'); }

async function call(agent, lead, outcome, extra = {}) {
  return agentSvc.callLog(agent, String(lead._id), { outcome, direction: extra.direction || 'outbound', durationSec: outcome === 'connected' ? (extra.durationSec || 240) : undefined, note: extra.note });
}

async function scheduleVisit(agent, lead, p, extra = {}) {
  const at = extra.at || await findSlot(lead.assignedTo, p, { fromDay: extra.fromDay || 1 });
  return agentSvc.scheduleVisit(agent, { leadId: String(lead._id), propertyId: String(p._id), scheduledAt: at, durationMin: 45, meetingPoint: extra.meetingPoint || 'Society main gate', buyerNote: 'Please carry a photo ID', pickup: extra.pickup, overrideReason: extra.overrideReason });
}

// Visit that already happened: booked through the service, moved into the past, then the outcome is recorded.
async function completedVisit(agent, lead, p, n, outcome = {}) {
  const v = await scheduleVisit(agent, lead, p, outcome.schedule || {});
  await col(SiteVisit).updateOne({ _id: v._id }, { $set: { scheduledAt: pastSlot(n) } });
  const photoFileIds = outcome.photos ? [String((await media.uploadPhoto(agent._id, 'verification_photo', 'Visit selfie at the gate', `visit:${lead.leadNo}:1`, { w: 1024, h: 768 }))._id)] : [];
  await agentSvc.outcome(agent, String(v._id), {
    result: outcome.result || 'completed', interest: outcome.interest || 4, rating: outcome.rating || 4, objections: outcome.objections || ['parking'], feedback: outcome.feedback || 'Liked the layout and light; wants to discuss the price',
    offerAmount: outcome.offerAmount, nextStep: outcome.nextStep || 'Share revised price with the family', shareWithLister: Boolean(outcome.share), listerSummary: outcome.share ? 'Buyer liked the flat and may make an offer this week.' : undefined, photoFileIds,
  }, fakeReq(agent));
  return SiteVisit.findById(v._id);
}

async function feedback(v, body) {
  const job = await Job.findOne({ uniqueKey: `feedback:${v._id}` });
  if (!job) return;
  await leadJobs.feedbackRequest({ visitId: String(v._id), token: job.payload.token }); // the "send feedback link" job, run now
  await buyerSvc.submitFeedback(job.payload.token, body);
  await Job.updateOne({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date() } });
}

async function offer(agent, lead, p, amount, extra = {}) {
  return agentSvc.recordOffer(agent, String(lead._id), { propertyId: String(p._id), amount, terms: extra.terms || { token: Math.round(amount * 0.02), possessionDate: istAt(45, 12), inclusions: 'Modular kitchen and wardrobes' }, validityDays: extra.validityDays, note: extra.note || 'Buyer is pre-approved for a home loan' });
}

// Lead pipeline up to a stage (and optionally an accepted offer for deals).
async function progress(ctx, lead, spec, n) {
  lead = await Lead.findById(lead._id);
  const agent = await agentOf(lead);
  const want = spec.stage;
  const t = targetOf(ctx, spec);
  const p = t.property && await Property.findById(t.property._id);
  if (want === 'new' || ['closed_won', 'closed_lost'].includes(lead.stage) || lead.mergedInto) return lead;
  if (idx(want) >= idx('contacted') && lead.stage === 'new') {
    if (spec.unanswered) { for (const o of ['no_answer', 'busy', 'switched_off']) await call(agent, lead, o); }
    await call(agent, lead, 'connected', { note: 'Discussed budget, timeline and family size' });
    await agentSvc.note(agent, String(lead._id), { text: spec.note || 'Prefers weekend visits. Wife will join the second visit.' });
    lead = await Lead.findById(lead._id);
  }
  if (idx(want) >= idx('qualified') && ['new', 'contacted'].includes(lead.stage)) {
    await agentSvc.stage(agent, String(lead._id), { stage: 'qualified', note: 'Budget and need confirmed' });
    lead = await Lead.findById(lead._id);
  }
  if (p && want === 'site_visit_scheduled' && !(await SiteVisit.exists({ leadId: lead._id, status: { $in: ['scheduled', 'confirmed'] } }))) {
    await scheduleVisit(agent, lead, p, { pickup: spec.pickup });
    lead = await Lead.findById(lead._id);
  }
  if (p && idx(want) >= idx('site_visit_done') && !(await SiteVisit.exists({ leadId: lead._id, status: 'completed' }))) {
    await completedVisit(agent, lead, p, n, spec.visit || {});
    lead = await Lead.findById(lead._id);
  }
  if (!p && idx(want) >= idx('negotiation') && idx(lead.stage) < idx('negotiation')) {
    await agentSvc.stage(agent, String(lead._id), { stage: 'negotiation', note: 'Discussing payment plan for the chosen unit' });
    lead = await Lead.findById(lead._id);
  }
  return lead;
}

// ---------------------------------------------------------------- the leads

const G = (name, phone, email) => ({ name, phone, ...(email ? { email } : {}) });
const LEADS = [
  { key: 'n1', on: 'o2', guest: G('Rakesh Gupta', '+919833000201', 'rakesh.gupta@demo.local'), agent: 'agent@demo.local', stage: 'new', slaBreach: true, form: { callbackWindow: 'evening', budgetMax: 35000000, timeline: '1_3_months', loanNeeded: true }, utm: { source: 'google', medium: 'cpc', campaign: 'kothrud-bungalows' }, message: 'Is the price negotiable for a quick deal?' },
  { key: 'n2', on: 'r2', guest: G('Ananya Singh', '+919833000202'), agent: 'auto', source: 'callback', stage: 'new', whatsapp: true, form: { callbackWindow: 'morning' }, message: 'Please call after 10 am' },
  { key: 'n3', kind: 'requirement', guest: G('Mohit Bansal', '+919833000203', 'mohit.bansal@demo.local'), agent: null, stage: 'new', requirement: { city: 'Mumbai', localities: ['Andheri West'], purpose: 'rent', category: 'residential', types: ['apartment'], bhk: [2], budgetMax: 60000, timeline: 'immediate', notes: 'Relocating from Pune, needs a 2 BHK near the metro' } },
  { key: 'n4', kind: 'requirement', buyer: 'buyer@demo.local', agent: 'agent@demo.local', stage: 'contacted', requirement: { city: 'Pune', localities: ['Baner', 'Wakad'], purpose: 'sale', category: 'residential', types: ['apartment'], bhk: [2, 3], budgetMin: 8000000, budgetMax: 13000000, timeline: '3_6_months', loanNeeded: true, notes: 'Looking for a 2 or 3 BHK near good schools', alertMe: true } },
  { key: 'n5', kind: 'contact', guest: G('Lata Deshpande', '+919833000218', 'lata.d@demo.local'), agent: 'agent2@demo.local', stage: 'contacted', city: 'Pune', message: 'I want to list my flat with you and also buy a bigger one in Kothrud' },
  { key: 'c1', on: 'r1', buyer: 'buyer@demo.local', agent: 'agent@demo.local', stage: 'contacted', whatsapp: true, form: { visitors: 2 }, message: 'Is the society pet friendly?', followUp: true, reassignRequest: 'open' },
  { key: 'q1', on: 'r7', guest: G('Neha Kulkarni', '+919833000204'), agent: 'agent@demo.local', source: 'site_visit', stage: 'qualified', whatsapp: true, form: { visitors: 3, pickupNeeded: true } },
  { key: 'vs1', on: 's2', buyer: 'buyer2@demo.local', agent: 'agent@demo.local', source: 'best_price', stage: 'site_visit_scheduled', visitFlow: 'confirm_reschedule', offerFlow: 'declined', referralCode: undefined },
  { key: 'vd1', on: 'r5', guest: G('Sameer Khan', '+919833000205', 'sameer.khan@demo.local'), agent: 'agent@demo.local', stage: 'site_visit_done', visit: { share: true, interest: 5, objections: ['rent'], photos: true }, feedback: { interest: 5, likes: ['location', 'furnishing'], dislikes: ['parking'], comments: 'Good office, need two more cabins', secondVisit: true, callBack: true }, reassignRequest: 'approve' },
  { key: 'ng1', on: 'b1', buyer: 'buyer@demo.local', agent: 'agent@demo.local', stage: 'negotiation', visit: { schedule: { pickup: { needed: true, address: 'Hotel Sayaji, Wakad' } }, offerAmount: 8500000 }, offerFlow: 'open', extras: ['link', 'share', 'reveal', 'override', 'whatsapp'] },
  { key: 'ng2', on: 'o2', guest: G('Kiran Desai', '+919833000206', 'kiran.desai@demo.local'), agent: 'agent@demo.local', stage: 'negotiation', offerFlow: 'countered', listerUpdate: true },
  { key: 'ng3', on: 'o1', guest: G('Aditi Sharma', '+919833000207', 'aditi.sharma@demo.local'), agent: 'agent@demo.local', stage: 'negotiation', offerFlow: 'accepted', form: { loanNeeded: true, timeline: 'immediate' } },
  { key: 'l1', on: 'o3', guest: G('Manoj Tiwari', '+919833000208'), agent: 'agent@demo.local', stage: 'qualified', lost: { lostReason: 'budget_mismatch', lostNote: 'Budget is 2 Cr, the villa is 2.75 Cr' }, cancelVisit: true },
  { key: 'l2', on: 's4', guest: G('Suresh Yadav', '+919833000209'), agent: 'agent@demo.local', stage: 'new', unansweredOnly: true, lost: { lostReason: 'not_responding', lostNote: 'Three calls, no answer' }, seekerFlag: 'open' },
  { key: 'e1', on: 'p1', guest: G('Pallavi Joshi', '+919833000210'), agent: 'agent@demo.local', stage: 'qualified', noShow: true, offerFlow: 'expired' },
  { key: 'w1', on: 'r2', buyer: 'buyer3@demo.local', agent: 'agent3@demo.local', stage: 'qualified', offerFlow: 'withdrawn' },
  { key: 'pj1', project: 'greens', config: '2 BHK Classic', guest: G('Rohit Jain', '+919833000211', 'rohit.jain@demo.local'), agent: 'agent2@demo.local', stage: 'negotiation', form: { budgetMax: 9000000, loanNeeded: true } },
  { key: 'm1', on: 's1', guest: G('Varun Mehta', '+919833000212'), agent: 'agent@demo.local', stage: 'contacted' },
  { key: 'm2', on: 's6', guest: G('Varun Mehta', '+919833000212'), agent: 'agent@demo.local', stage: 'new', mergeInto: 'm1' },
  { key: 'rc1', on: 'r6', guest: G('Nikhil Rane', '+919833000213'), agent: 'agent@demo.local', stage: 'contacted', lost: { lostReason: 'not_interested', lostNote: 'Wanted a bigger shop' }, recycle: true },
  { key: 'th1', kind: 'manual', source: 'whatsapp', on: 's5', guest: G('Sunil Kale', '+919833000214'), agent: 'agent2@demo.local', stage: 'new', seekerFlag: 'throttle', message: 'Messaged the sales WhatsApp about every new listing' },
  { key: 'th2', on: 'r6', guest: G('Sunil Kale', '+919833000214'), agent: null, stage: 'new' }, // throttled: lands in the manager queue
  { key: 'bl1', on: 'p1', guest: G('Bogus Caller', '+919833000215'), agent: 'agent2@demo.local', stage: 'new', seekerFlag: 'block' },
  { key: 'hl1', kind: 'manual', on: 's5', source: 'hotline', guest: G('Gopal Nair', '+919833000216'), agent: 'agent@demo.local', stage: 'contacted', referralOf: 'buyer2@demo.local', message: 'Called the hotline after seeing the newspaper ad', requirement: { purpose: 'sale', city: 'Pune', bhk: [3], budgetMax: 22000000 } },
  { key: 'wk1', kind: 'manual', on: 'r1', source: 'walk_in', guest: G('Farhan Ali', '+919833000217'), agent: 'agent3@demo.local', stage: 'qualified', message: 'Walked into the Kharadi office' },
];

async function extrasFor(ctx, spec, n) {
  let lead = await Lead.findById(ctx.leads[spec.key]._id);
  const agent = await agentOf(lead);
  const t = targetOf(ctx, spec);
  const p = t.property;
  const sa = ctx.users.superadmin;
  // Follow-ups: one done with a next one, one overdue.
  if (spec.followUp && !(await FollowUp.exists({ leadId: lead._id }))) {
    const f = await agentSvc.createFollowup(agent, { leadId: String(lead._id), type: 'call', dueAt: new Date(Date.now() + 2 * HOUR), note: 'Confirm visit timing' });
    await agentSvc.completeFollowup(agent, String(f._id), { outcome: 'Buyer wants to see it on Saturday', next: { dueAt: istAt(2, 11), type: 'whatsapp', note: 'Send the visit confirmation' } });
    await agentSvc.createFollowup(agent, { leadId: String(lead._id), type: 'email', dueAt: new Date(Date.now() + 30 * 60000), note: 'Email the society rules PDF' });
    const od = await FollowUp.create({ leadId: lead._id, agentId: agent._id, type: 'meeting', dueAt: daysAgo(1), remindAt: new Date(Date.now() - DAY - 15 * 60000), note: 'Meet at the Kharadi office (missed)' });
    await col(FollowUp).updateOne({ _id: od._id }, { $set: { createdAt: daysAgo(3) } });
  }
  if (spec.slaBreach && !lead.slaBreachedAt) {
    await col(Lead).updateOne({ _id: lead._id }, { $set: { slaDueAt: new Date(Date.now() - 3 * HOUR), assignedAt: new Date(Date.now() - 6 * HOUR) } });
    await leadJobs.slaSweep();
  }
  if (spec.unanswered === undefined && spec.unansweredOnly && lead.callAttempts < 3) {
    for (const o of ['no_answer', 'busy', 'switched_off']) await call(agent, lead, o, { note: 'Tried after 6 pm' });
    lead = await Lead.findById(lead._id);
  }
  if (spec.cancelVisit && !(await SiteVisit.exists({ leadId: lead._id, status: 'cancelled' }))) {
    const v = await scheduleVisit(agent, lead, p, { fromDay: 3 });
    await agentSvc.cancelVisit(agent, String(v._id), { reason: 'Buyer said the budget does not stretch this far' });
    lead = await Lead.findById(lead._id);
  }
  if (spec.noShow && !(await SiteVisit.exists({ leadId: lead._id, status: 'no_show' }))) {
    const v = await scheduleVisit(agent, lead, p);
    await col(SiteVisit).updateOne({ _id: v._id }, { $set: { scheduledAt: pastSlot(n + 2) } });
    await agentSvc.outcome(agent, String(v._id), { result: 'no_show', feedback: 'Buyer did not come and did not answer the phone' }, fakeReq(agent));
    lead = await Lead.findById(lead._id);
  }
  if (spec.visitFlow === 'confirm_reschedule') {
    const v = await SiteVisit.findOne({ leadId: lead._id, status: { $in: ['scheduled', 'confirmed'] } });
    if (v && v.status === 'scheduled' && !v.rescheduleCount) {
      const newAt = await findSlot(lead.assignedTo, p, { fromDay: 4 });
      await agentSvc.rescheduleVisit(agent, String(v._id), { scheduledAt: newAt, rescheduleReason: 'Owner travelling on the earlier date' }, fakeReq(agent));
      const buyer = await u(spec.buyer);
      await buyerSvc.meConfirm(buyer, String(v._id));
      await buyerSvc.meReschedule(buyer, String(v._id), { note: 'Can we move it to Sunday morning?' });
      await leadJobs.visitReminder({ visitId: String(v._id), kind: 'buyer24', scheduledAt: newAt }); // reminder job fired early for the demo
    }
  }
  if (spec.feedback) {
    const v = await SiteVisit.findOne({ leadId: lead._id, status: 'completed' });
    if (v && !(v.feedback && v.feedback.submittedAt)) await feedback(v, spec.feedback);
  }
  // Offers.
  if (spec.offerFlow && !(await Offer.exists({ leadId: lead._id }))) {
    const listed = p.purpose === 'rent' ? p.price.monthlyRent / 100 : p.price.amount / 100;
    const lister = await User.findById(p.listerId);
    if (spec.offerFlow === 'open') await offer(agent, lead, p, Math.round(listed * 0.94), { note: 'Buyer can close within 30 days' });
    if (spec.offerFlow === 'countered') {
      const o = await offer(agent, lead, p, Math.round(listed * 0.88));
      await listerSvc.respondOffer(lister, String(o._id), { action: 'counter', amount: Math.round(listed * 0.95), note: 'Lowest I can go', terms: { token: 500000, possessionDate: istAt(60, 12), inclusions: 'Furniture in the living room' } });
      await agentSvc.relay(agent, String(o._id));
    }
    if (spec.offerFlow === 'accepted') {
      const o = await offer(agent, lead, p, Math.round(listed * 0.96));
      await listerSvc.respondOffer(lister, String(o._id), { action: 'accept', note: 'Agreed, please proceed with the booking' });
    }
    if (spec.offerFlow === 'declined') {
      const o = await offer(agent, lead, p, Math.round(listed * 0.8));
      await listerSvc.respondOffer(lister, String(o._id), { action: 'decline', reason: 'Too low; will not go below the listed price by more than 5%' });
    }
    if (spec.offerFlow === 'withdrawn') {
      const o = await offer(agent, lead, p, Math.round(listed * 0.92), { validityDays: 3 });
      await agentSvc.withdraw(agent, String(o._id), { note: 'Buyer found a place closer to work' });
    }
    if (spec.offerFlow === 'expired') {
      const o = await offer(agent, lead, p, Math.round(listed * 0.9), { validityDays: 1 });
      await col(Offer).updateOne({ _id: o._id }, { $set: { validUntil: new Date(Date.now() - HOUR) } });
      await leadJobs.offerSweep();
    }
    lead = await Lead.findById(lead._id);
  }
  if (spec.listerUpdate && !(await ListerUpdate.exists({ leadId: lead._id, tag: 'negotiation' }))) {
    const up = await agentSvc.shareUpdate(agent, String(lead._id), { propertyId: String(p._id), text: 'Buyer is serious and has a pre-approved loan; asking whether the price can come down a little.', tag: 'negotiation', amount: Math.round(p.price.amount / 100 * 0.9) }, fakeReq(agent));
    const lister = await User.findById(p.listerId);
    await listerSvc.respond(lister, String(up._id), { response: 'Open to a small discount if the booking happens this month.' }, fakeReq(lister));
  }
  // Extras on the buyer@demo.local negotiation lead.
  if ((spec.extras || []).length && !(await ContactReveal.exists({ leadId: lead._id }))) {
    if (spec.extras.includes('link')) await agentSvc.linkProperty(agent, String(lead._id), { propertyId: String(ctx.listings.b2._id) });
    if (spec.extras.includes('share')) await agentSvc.shareListings(agent, String(lead._id), { propertyIds: [String(ctx.listings.b3._id), String(ctx.listings.b4._id)], note: 'Two more options in the same budget' });
    if (spec.extras.includes('reveal')) {
      await reveal.revealBuyer(String(lead._id), { field: 'phone' }, fakeReq(agent));
      await reveal.revealLister(String(p._id), { field: 'phone' }, fakeReq(agent));
      const mgr = await u('manager@demo.local');
      await reveal.revealBuyer(String(lead._id), { field: 'email' }, fakeReq(mgr));
    }
    if (spec.extras.includes('override')) {
      // Manager books a second visit at 19:00, outside the builder's visit hours, with a reason.
      const mgr = await u('manager@demo.local');
      await agentSvc.scheduleVisit(mgr, { leadId: String(lead._id), propertyId: String(p._id), scheduledAt: istAt(5, 19, 0), durationMin: 30, meetingPoint: 'Sales office', overrideReason: 'Buyer works late; site manager agreed to stay back' });
    }
  }
  // Reassignment requests: one left open, one approved by the manager.
  if (spec.reassignRequest && !(lead.reassignRequests || []).length) {
    await agentSvc.reassignRequest(agent, String(lead._id), { reason: spec.reassignRequest === 'open' ? 'Buyer prefers a Marathi-speaking agent' : 'I am on site visits all week; Priya covers Hinjewadi' });
    if (spec.reassignRequest === 'approve') {
      const fresh = await Lead.findById(lead._id);
      const mgr = await u('manager@demo.local');
      const a2 = await u('agent2@demo.local');
      await adminSvc.decideRequest(mgr, String(lead._id), String(fresh.reassignRequests[0]._id), { decision: 'approve', agentId: String(a2._id), note: 'Moved to Priya' }, fakeReq(mgr));
    }
  }
  if (spec.reassignRequest === 'approve') { // earlier versions of this seed reassigned it back on a rerun; keep it with agent2
    const fresh = await Lead.findById(lead._id);
    const a2 = await u('agent2@demo.local');
    if ((fresh.reassignRequests || []).some((r) => r.status === 'approved') && String(fresh.assignedTo) !== String(a2._id)) {
      const mgr = await u('manager@demo.local');
      await adminSvc.assign(mgr, String(fresh._id), { agentId: String(a2._id), reason: 'Reassignment request approved' }, fakeReq(mgr));
    }
  }
  // Lost.
  lead = await Lead.findById(lead._id);
  if (spec.lost && lead.stage !== 'closed_lost' && !lead.recycledFrom) {
    await agentSvc.stage(agent, String(lead._id), { stage: 'closed_lost', ...spec.lost });
    lead = await Lead.findById(lead._id);
  }
  if (spec.recycle && lead.stage === 'closed_lost' && !(await Lead.exists({ recycledFrom: lead._id }))) {
    await col(Lead).updateOne({ _id: lead._id }, { $set: { closedAt: daysAgo(40), createdAt: daysAgo(55) } });
    await adminSvc.recycle(sa, String(lead._id), fakeReq(sa));
  }
  if (spec.mergeInto && !lead.mergedInto) {
    await adminSvc.merge(sa, String(lead._id), { intoLeadId: String(ctx.leads[spec.mergeInto]._id) }, fakeReq(sa));
  }
  // Seeker flags (RE-F-10): open (manual), throttled, blocked.
  if (spec.seekerFlag && !lead.seekerFlagId) {
    const fl = await seeker.manualFlag(agent, String(lead._id), { note: spec.seekerFlag === 'open' ? 'Same number enquired on many listings with different names' : 'Enquires on every new listing, never visits' }, fakeReq(agent));
    if (spec.seekerFlag !== 'open') {
      const f = await SeekerFlag.findOne({ flagNo: fl.flagNo });
      await seeker.decide(String(f._id), { action: spec.seekerFlag, note: spec.seekerFlag === 'block' ? 'Abusive messages to listers' : 'Limit to one enquiry a day for a month', days: spec.seekerFlag === 'block' ? 15 : 30 }, fakeReq(sa));
    }
  }
}

async function seedLeads(ctx) {
  ctx.leads = ctx.leads || {};
  for (const [n, spec] of LEADS.entries()) {
    await step(`lead ${spec.key}`, async () => {
      if (spec.referralOf) spec.referralCode = (await User.findOne({ email: spec.referralOf }).select('referralCode')).referralCode;
      const lead = await ensureLead(ctx, spec);
      if (lead.assignedTo) ctx.leads[spec.key] = await progress(ctx, lead, spec, n);
      if (lead.assignedTo || spec.mergeInto) await extrasFor(ctx, spec, n);
      return true;
    });
  }
  await step('consents: WhatsApp withdrawn, marketing given', async () => {
    const buyer = await u('buyer@demo.local');
    const { Consent } = require('../../src/modules/auth/models');
    if (await Consent.exists({ subjectId: buyer._id, purpose: 'whatsapp_updates', withdrawnAt: { $ne: null } })) return 'skip';
    await account.giveConsent(buyer, { purpose: 'marketing_alerts', source: 'banner' }, fakeReq(buyer));
    await account.giveConsent(buyer, { purpose: 'analytics', source: 'banner' }, fakeReq(buyer));
    await account.withdrawConsent(buyer, 'whatsapp_updates', fakeReq(buyer));
    return true;
  });
}

module.exports = { seedLeads, ensureLead, progress, completedVisit, offer, findSlot, scheduleVisit, feedback, LEADS, agentOf, call };
