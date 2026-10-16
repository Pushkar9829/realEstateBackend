// Deals, receivables, invoices, payments, disputes, write-offs, partners and the
// MLM outbox, all through the real services: deal create -> documents -> submit
// -> claim -> verify / return / reject (verify runs the transaction that marks
// the listing sold / rented, wins the lead, creates the receivable and the
// deal.closed outbox event). Matched by lead (one deal per lead).
const { Deal, Partner, PartnerReferral } = require('../../src/modules/deals/models');
const { Receivable } = require('../../src/modules/receivables/models');
const { Lead, Offer } = require('../../src/modules/leads/models');
const { Property } = require('../../src/modules/listings/models');
const { User } = require('../../src/modules/auth/models');
const Outbox = require('../../src/core/outbox/Outbox.model');
const outbox = require('../../src/core/outbox');
const deals = require('../../src/modules/deals/service');
const receivables = require('../../src/modules/receivables/service');
const partners = require('../../src/modules/deals/partners.service');
const listerSvc = require('../../src/modules/leads/lister.service');
const media = require('./media');
const leads = require('./leads');
const { fakeReq, step, col, daysAgo, daysAhead, istAt, HOUR, DAY } = require('./context');

const u = (email) => User.findOne({ email }).select('+permissions');
const G = (name, phone, email) => ({ name, phone, ...(email ? { email } : {}) });

// target: verified | submitted | under_review | returned | rejected | cancelled | draft
const DEALS = [
  { key: 'dv1', on: 'o9', guest: G('Harish Menon', '+919833000401', 'harish.menon@demo.local'), agent: 'agent@demo.local', target: 'verified', rec: 'invoiced_with_credit_note', pay: 'bank_transfer' },
  { key: 'dv2', on: 'o10', guest: G('Deepa Nair', '+919833000402', 'deepa.nair@demo.local'), agent: 'agent@demo.local', target: 'verified', rec: 'overdue', pay: 'cheque' },
  { key: 'dv3', on: 'b2', buyer: 'buyer2@demo.local', agent: 'agent@demo.local', target: 'verified', rec: 'partially_paid', pay: 'upi', loan: true },
  { key: 'dv4', on: 'r3', guest: G('Tanvi Kulkarni', '+919833000404', 'tanvi.k@demo.local'), agent: 'agent@demo.local', target: 'verified', rec: 'paid', pay: 'bank_transfer', rental: true },
  { key: 'dv5', on: 's3', guest: G('Prakash Rao', '+919833000405', 'prakash.rao@demo.local'), agent: 'agent@demo.local', target: 'verified', rec: 'disputed', pay: 'dd' },
  { key: 'dv6', on: 's5', guest: G('Meenal Shah', '+919833000406', 'meenal.shah@demo.local'), agent: 'agent2@demo.local', target: 'verified', rec: 'written_off', pay: 'bank_transfer' },
  { key: 'dv7', on: 'b3', guest: G('Yash Patil', '+919833000407', 'yash.patil@demo.local'), agent: 'agent2@demo.local', target: 'verified', rec: 'pending_invoice', pay: 'upi' },
  { key: 'ds1', on: 'r1', guest: G('Ravi Shankar', '+919833000411', 'ravi.shankar@demo.local'), agent: 'agent3@demo.local', target: 'submitted', pay: 'upi', slaWarn: true },
  { key: 'du1', on: 'b4', guest: G('Kavya Iyer', '+919833000412', 'kavya.iyer@demo.local'), agent: 'agent2@demo.local', target: 'under_review', pay: 'bank_transfer' },
  { key: 'dr1', on: 's1', guest: G('Ajay Kumar', '+919833000413'), agent: 'agent@demo.local', target: 'returned', pay: 'cash', bookingAmount: 300000 },
  { key: 'dj1', on: 's6', guest: G('Bhavna Thakur', '+919833000414'), agent: 'agent@demo.local', target: 'rejected', pay: 'cheque', priceFactor: 0.65, justification: 'Flat needs full renovation; buyer pays the society dues of two years' },
  { key: 'dc1', on: 'b5', guest: G('Sanjana Bose', '+919833000415', 'sanjana.bose@demo.local'), agent: 'agent2@demo.local', target: 'cancelled', pay: 'bank_transfer' },
];

async function docs(agent, deal, spec) {
  const d = await Deal.findById(deal._id);
  if (d.documents.length) return;
  const ref = `UTR${spec.key.toUpperCase()}${String(deal.dealNo).replace(/\D/g, '')}`;
  const receipt = await media.uploadPdf(agent._id, 'receipt', `Booking receipt ${deal.dealNo}`, [`Received from the buyer: token amount`, `Mode: ${spec.pay}`, `Reference: ${ref}`], `receipt:${deal.dealNo}`);
  const agreement = await media.uploadPdf(agent._id, 'agreement_doc', `${d.dealType === 'rent' ? 'Leave and licence draft' : 'Agreement for sale'} ${deal.dealNo}`, ['Signed by both parties (demo)'], `agreement:${deal.dealNo}`);
  await deals.addDocument(agent, String(deal._id), { fileId: String(receipt._id), kind: 'receipt', label: 'Token receipt', reference: ref }, fakeReq(agent));
  await deals.addDocument(agent, String(deal._id), { fileId: String(agreement._id), kind: 'agreement', label: 'Signed agreement' }, fakeReq(agent));
}

async function ensureDeal(ctx, spec) {
  const lead = await leads.ensureLead(ctx, { ...spec, stage: 'site_visit_done', source: 'enquiry', form: { timeline: 'immediate', loanNeeded: Boolean(spec.loan) } });
  let deal = await Deal.findOne({ leadId: lead._id });
  if (!deal) {
    await leads.progress(ctx, lead, { ...spec, stage: 'site_visit_done', visit: { interest: 5, objections: [], feedback: 'Family loved it; ready to book' } }, ctx.dealSeq++);
    const fresh = await Lead.findById(lead._id);
    const agent = await leads.agentOf(fresh);
    const p = await Property.findById(ctx.listings[spec.on]._id);
    const lister = await User.findById(p.listerId);
    const listed = (p.purpose === 'rent' ? p.price.monthlyRent : p.price.amount) / 100;
    const agreed = Math.round(listed * (spec.priceFactor || 0.97) / 1000) * 1000;
    const bookingAmount = spec.bookingAmount || (p.purpose === 'rent' ? agreed * 2 : Math.round(agreed * 0.05));
    let offerId;
    if (!spec.priceFactor) {
      let o = await Offer.findOne({ leadId: lead._id, status: 'accepted' });
      if (!o) {
        o = await leads.offer(agent, fresh, p, agreed, { terms: { token: bookingAmount, possessionDate: istAt(30, 12), inclusions: p.purpose === 'rent' ? 'Two months deposit' : 'Covered parking' } });
        await listerSvc.respondOffer(lister, String(o._id), { action: 'accept', note: 'Accepted, go ahead with the booking' });
      }
      offerId = String(o._id);
    }
    await deals.create(agent, {
      leadId: String(lead._id), offerId, ...(p.purpose === 'rent' ? { monthlyRent: agreed } : { agreedPrice: agreed }), bookingAmount, bookingDate: new Date(), paymentMode: spec.pay,
      paymentReference: `UTR${spec.key.toUpperCase()}${Date.now().toString().slice(-6)}`, notes: 'Booking done at the site office', justification: spec.justification,
    }, fakeReq(agent));
    deal = await Deal.findOne({ leadId: lead._id });
  }
  ctx.deals[spec.key] = deal;
  return deal;
}

async function driveDeal(ctx, spec) {
  let deal = await ensureDeal(ctx, spec);
  const agent = await User.findById(deal.agentId).select('+permissions');
  const fin = ctx.users['finance@demo.local'];
  if (deal.status === 'draft' && spec.target === 'cancelled') { await deals.cancel(agent, String(deal._id), { reason: 'Buyer backed out after the home loan was delayed' }, fakeReq(agent)); return; }
  if (deal.status === 'draft') { await docs(agent, deal, spec); await deals.submit(agent, String(deal._id), fakeReq(agent)); deal = await Deal.findById(deal._id); }
  if (spec.target === 'submitted' && spec.slaWarn && !deal.slaWarnedAt) {
    await col(Deal).updateOne({ _id: deal._id }, { $set: { submittedAt: new Date(Date.now() - 62 * HOUR) } });
    await deals.slaWarnings();
    return;
  }
  if (deal.status === 'submitted' && spec.target !== 'submitted') { await deals.claim(fin, String(deal._id), fakeReq(fin)); deal = await Deal.findById(deal._id); }
  if (deal.status !== 'under_review' || spec.target === 'under_review') return;
  const req = fakeReq(fin, { headers: { 'idempotency-key': `demo-${spec.key}` } });
  if (spec.target === 'returned') await deals.decide(fin, String(deal._id), { decision: 'return', comment: 'Receipt amount does not match the booking amount; upload the bank statement page', checklist: { receipt_matches: false } }, req);
  if (spec.target === 'rejected') await deals.decide(fin, String(deal._id), { decision: 'reject', reason: 'The buyer was introduced by another broker before our first contact', comment: 'Lister confirmed on call' }, req);
  if (spec.target === 'verified') {
    await deals.decide(fin, String(deal._id), {
      decision: 'verify', checklist: { receipts_genuine: true, amounts_match: true, agreement_signed: true, visit_logged: true },
      comment: 'Receipts match the bank statement', note: spec.pay === 'cash' ? 'Cash above the limit confirmed with the buyer PAN' : 'Verified against the bank statement',
    }, req);
  }
}

// ---------------------------------------------------------------- receivables

async function receivable(ctx, spec) {
  const deal = await Deal.findById(ctx.deals[spec.key]._id);
  if (deal.status !== 'verified') return 'skip';
  let r = await Receivable.findOne({ dealId: deal._id });
  if (!r || r.invoices.length || r.status !== 'pending_invoice' || spec.rec === 'pending_invoice') return 'skip';
  const fin = ctx.users['finance@demo.local'];
  const req = fakeReq(fin);
  const id = String(r._id);
  const lister = await User.findById(r.listerId);
  const issueAll = async (amount) => {
    const d = await receivables.draftInvoice(fin, id, amount ? { amount, note: 'First milestone' } : { note: 'Full commission' }, req);
    return receivables.issue(fin, String(d.invoice._id), { dueDays: 30 }, req);
  };
  if (spec.rec === 'invoiced_with_credit_note') {
    const first = await issueAll(Math.round(r.commissionAmount / 100 / 2));
    await receivables.cancelInvoice(fin, String(first.invoice._id), { reason: 'Issued on the wrong billing name; reissued' }, req);
    await issueAll();
  }
  if (spec.rec === 'overdue') {
    const out = await issueAll();
    await receivables.dispute(fin, id, { reason: 'Lister says the commission percent on the invoice is wrong' }, req);
    await receivables.resolve(fin, id, { note: 'Checked the agreement: 2% is correct; lister agreed' }, req);
    // The invoice fell due a week ago: the daily job marks it overdue and sends the 7-day reminder.
    await col(Receivable).updateOne({ _id: r._id, 'invoices._id': out.invoice._id }, { $set: { 'invoices.$.dueDate': daysAgo(7), 'invoices.$.date': daysAgo(37), dueDate: daysAgo(7) } });
    await receivables.runDaily();
  }
  if (spec.rec === 'partially_paid') {
    const out = await issueAll();
    const total = out.invoice.total / 100;
    await receivables.recordPayment(fin, id, { amount: Math.round(total * 0.4), tds: Math.round(total * 0.02), mode: 'bank_transfer', reference: 'HDFCN52026101700123', date: daysAgo(2) }, req);
    const proof1 = await media.uploadPdf(lister._id, 'payment_proof', 'NEFT screenshot', ['Transfer of commission instalment'], `proof:${spec.key}:1`);
    const p1 = await receivables.uploadProof(lister, String(out.invoice._id), { fileId: String(proof1._id), amount: 50000, tds: 0, date: daysAgo(1), mode: 'upi', reference: 'UPI/6301/xyz' }, fakeReq(lister));
    await receivables.decideProof(fin, id, String(p1._id), { decision: 'reject', reason: 'No such credit in our bank statement for this date' }, req);
    const proof2 = await media.uploadPdf(lister._id, 'payment_proof', 'RTGS advice', ['Second instalment'], `proof:${spec.key}:2`);
    await receivables.uploadProof(lister, String(out.invoice._id), { fileId: String(proof2._id), amount: Math.round(total * 0.3), tds: 0, date: new Date(), mode: 'bank_transfer', reference: 'RTGS0099812' }, fakeReq(lister));
  }
  if (spec.rec === 'paid') {
    const out = await issueAll();
    const total = out.invoice.total / 100;
    const tds = Math.round(out.invoice.taxable / 100 * 0.1);
    const proof = await media.uploadPdf(lister._id, 'payment_proof', 'Bank transfer advice', ['Full commission less TDS'], `proof:${spec.key}`);
    const pr = await receivables.uploadProof(lister, String(out.invoice._id), { fileId: String(proof._id), amount: total - tds, tds, date: new Date(), mode: 'bank_transfer', reference: 'ICIC00012345678' }, fakeReq(lister));
    await receivables.decideProof(fin, id, String(pr._id), { decision: 'confirm' }, req);
  }
  if (spec.rec === 'disputed') {
    const out = await issueAll();
    await receivables.listerDispute(lister, String(out.invoice._id), { reason: 'The buyer came through my own contact before listing here; commission not payable' }, fakeReq(lister));
  }
  if (spec.rec === 'written_off') {
    const out = await issueAll();
    await receivables.recordPayment(fin, id, { amount: Math.round(out.invoice.total / 100 * 0.5), mode: 'cheque', reference: 'CHQ 004512' }, req);
    await receivables.writeOff(fin, id, { reason: 'Goodwill discount agreed with the owner for a repeat listing', amount: 1000 }, req);
    await receivables.writeOff(fin, id, { reason: 'Owner moved abroad; remaining amount not recoverable' }, req);
  }
  return true;
}

// ---------------------------------------------------------------- partners

async function seedPartners(ctx) {
  const sa = ctx.users.superadmin;
  await step('partners', async () => {
    if (await Partner.exists({ name: 'HDFC Home Loans (demo)' })) return 'skip';
    const file = await media.uploadPdf(sa._id, 'signed_agreement', 'Partner agreement HDFC (demo)', ['Referral payout 0.25% of disbursed amount'], 'partner:hdfc');
    await partners.create({ name: 'HDFC Home Loans (demo)', type: 'bank', cities: ['Pune', 'Mumbai'], contact: { name: 'Rajiv Bhat', email: 'rajiv.bhat@hdfc.demo.local', phone: '+919822001001' }, payoutTerms: '0.25% of the disbursed amount within 45 days', agreementFileId: String(file._id) }, fakeReq(sa));
    await partners.create({ name: 'Bajaj Housing Finance (demo)', type: 'nbfc', cities: [], contact: { name: 'Shalini Rao', email: 'shalini.rao@bajaj.demo.local' }, payoutTerms: 'INR 5,000 per disbursed file' }, fakeReq(sa));
    await partners.create({ name: 'LegalDesk Rent Agreements (demo)', type: 'rental_agreement', cities: ['Pune'], contact: { name: 'Support desk', email: 'rent@legaldesk.demo.local', phone: '+919822001003' }, payoutTerms: 'Flat fee INR 1,500, registered agreement in 3 days' }, fakeReq(sa));
    await partners.create({ name: 'Old Cooperative Bank (inactive)', type: 'bank', cities: ['Pune'], contact: { email: 'loans@oldcoop.demo.local' }, active: false }, fakeReq(sa));
    return true;
  });
  await step('loan referrals', async () => {
    if (await PartnerReferral.exists({ kind: 'loan' })) return 'skip';
    const hdfc = await Partner.findOne({ name: 'HDFC Home Loans (demo)' });
    const bajaj = await Partner.findOne({ name: 'Bajaj Housing Finance (demo)' });
    const lead = await Lead.findById(ctx.leads.dv3_lead);
    const agent = await User.findById(lead.assignedTo).select('+permissions');
    const r1 = await partners.referLoan(agent, String(lead._id), { partnerId: String(hdfc._id), loanAmount: 10000000, consent: true, note: 'Salaried, CIBIL above 780' }, fakeReq(agent));
    for (const st of [{ status: 'contacted', partnerRef: 'HDFC-PUN-77812', note: 'Bank called the buyer' }, { status: 'sanctioned', sanctionedAmount: 9500000, note: 'Sanction letter issued' }, { status: 'disbursed', disbursedAmount: 9500000, payoutDue: 23750, payoutReceived: 23750, note: 'First tranche disbursed' }]) {
      await partners.patchReferral(String(r1._id), st, fakeReq(ctx.users['finance@demo.local']));
    }
    const ng1 = await Lead.findById(ctx.leads.ng1._id);
    const a2 = await User.findById(ng1.assignedTo).select('+permissions');
    const r2 = await partners.referLoan(a2, String(ng1._id), { partnerId: String(bajaj._id), loanAmount: 7000000, consent: true }, fakeReq(a2));
    await partners.patchReferral(String(r2._id), { status: 'contacted', note: 'Documents collected' }, fakeReq(ctx.users['finance@demo.local']));
    await partners.patchReferral(String(r2._id), { status: 'rejected', note: 'Income proof insufficient for the amount' }, fakeReq(ctx.users['finance@demo.local']));
    return true;
  });
  await step('rental agreement request', async () => {
    if (await PartnerReferral.exists({ kind: 'rental_agreement' })) return 'skip';
    const legal = await Partner.findOne({ name: 'LegalDesk Rent Agreements (demo)' });
    const deal = await Deal.findById(ctx.deals.dv4._id);
    const agent = await User.findById(deal.agentId).select('+permissions');
    const r = await partners.requestRentalAgreement(agent, String(deal._id), { partnerId: String(legal._id), fee: 1500, payer: 'split', tenantConsent: true, landlordConsent: true, note: 'Registration at Baner sub-registrar' }, fakeReq(agent));
    const fin = ctx.users['finance@demo.local'];
    await partners.patchReferral(String(r._id), { status: 'in_progress', partnerRef: 'LD-RA-55120', payoutDue: 300, note: 'Draft shared with both parties' }, fakeReq(fin));
    const pdf = await media.uploadPdf(agent._id, 'agreement_doc', 'Registered leave and licence', ['Registered on e-registration portal (demo)'], 'rental:final');
    await partners.patchReferral(String(r._id), { status: 'completed', fileId: String(pdf._id), payoutReceived: 300, note: 'Registered agreement delivered' }, fakeReq(fin));
    return true;
  });
}

// ---------------------------------------------------------------- MLM outbox (sent / failed / dead)

async function seedOutbox(ctx) {
  await step('MLM outbox events', async () => {
    const b2 = await User.findOne({ email: 'buyer2@demo.local' });
    if (await Outbox.exists({ type: 'user.signup', aggregateId: b2._id })) return 'skip';
    const now = Date.now();
    const sent = await outbox.record('user.signup', { userRef: `u_${b2._id}`, role: 'buyer', listerType: null, referralCode: b2.referredBy, referralCapturedAt: b2.referralCapturedAt, signedUpAt: b2.createdAt }, { aggregateId: b2._id });
    await Outbox.updateOne({ _id: sent._id }, { $set: { status: 'sent', attempts: 1, responseCode: 202, sentAt: new Date(now - 2 * HOUR), attemptLog: [{ at: new Date(now - 2 * HOUR), responseCode: 202 }] } });
    const dv1 = await Deal.findById(ctx.deals.dv1._id);
    const failed = await outbox.record('deal.closed', { dealNo: dv1.dealNo, dealType: 'sale', referralCode: 'MLMDEMO1', buyer: { referralCode: 'MLMDEMO1' }, commissionAmount: dv1.commissionAmount / 100, currency: 'INR' }, { aggregateId: dv1._id });
    await Outbox.updateOne({ _id: failed._id }, { $set: { attempts: 3, responseCode: 503, lastError: 'HTTP 503', nextAttemptAt: new Date(now + 6 * HOUR), attemptLog: [{ at: new Date(now - 3 * HOUR), responseCode: 503, error: 'HTTP 503' }, { at: new Date(now - 2 * HOUR), error: 'connect ETIMEDOUT' }, { at: new Date(now - HOUR), responseCode: 503, error: 'HTTP 503' }] } });
    const rev = await Deal.findOne({ dealNo: 'DL26-00002' });
    const dead = await outbox.record('deal.reversed', { dealNo: rev ? rev.dealNo : 'DL26-00002', reason: 'Buyer cancelled', buyer: { referralCode: 'BADCODE' }, lister: { referralCode: null } }, { aggregateId: rev && rev._id });
    await Outbox.updateOne({ _id: dead._id }, { $set: { status: 'dead', attempts: 1, responseCode: 422, lastError: '{"error":"Unknown referral code BADCODE"}', attemptLog: [{ at: new Date(now - 30 * 60000), responseCode: 422, error: 'rejected' }] } });
    return true;
  });
}

async function seedFinance(ctx) {
  ctx.deals = ctx.deals || {};
  ctx.dealSeq = 30;
  for (const spec of DEALS) {
    await step(`deal ${spec.key} (${spec.target})`, async () => {
      await driveDeal(ctx, spec);
      ctx.deals[spec.key] = await Deal.findOne({ leadId: ctx.leads[spec.key]._id });
      if (spec.key === 'dv3') ctx.leads.dv3_lead = ctx.deals.dv3.leadId;
      return true;
    });
  }
  await step('deal draft from the accepted offer (o1)', async () => {
    const lead = await Lead.findById(ctx.leads.ng3._id);
    if (await Deal.exists({ leadId: lead._id })) return 'skip';
    const o = await Offer.findOne({ leadId: lead._id, status: 'accepted' });
    const agent = await User.findById(lead.assignedTo).select('+permissions');
    await deals.create(agent, { leadId: String(lead._id), offerId: String(o._id), bookingDate: new Date(), paymentMode: 'bank_transfer', notes: 'Waiting for the token cheque to clear' }, fakeReq(agent));
    return true;
  });
  await step('project deal draft (Riverstone Greens unit)', async () => {
    const lead = await Lead.findById(ctx.leads.pj1._id);
    if (await Deal.exists({ leadId: lead._id })) return 'skip';
    const agent = await User.findById(lead.assignedTo).select('+permissions');
    await deals.create(agent, { leadId: String(lead._id), unitNo: 'A-501', agreedPrice: 8650000, bookingAmount: 200000, bookingDate: new Date(), paymentMode: 'cheque', paymentReference: 'CHQ 778812', notes: 'Unit A-501 on hold for the buyer' }, fakeReq(agent));
    return true;
  });
  for (const spec of DEALS.filter((d) => d.rec)) await step(`receivable ${spec.key} (${spec.rec})`, () => receivable(ctx, spec));
  await seedPartners(ctx);
  await seedOutbox(ctx);
}

module.exports = { seedFinance, DEALS };
