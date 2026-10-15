// Phase 5 (spec M5) - Module H deals and receipt verification, Module I
// commission receivables and invoicing, Module N outbox monitor and referral codes.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx2 = require('../phase2/fixtures');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead, SiteVisit, Offer } = require('../../src/modules/leads/models');
const { Property } = require('../../src/modules/listings/models');
const { Agreement } = require('../../src/modules/approvals/models');
const { Deal, Partner } = require('../../src/modules/deals/models');
const { Receivable } = require('../../src/modules/receivables/models');
const { Team } = require('../../src/modules/teams/models');
const { Outbox } = require('../../src/core/outbox');
const { User } = require('../../src/modules/auth/models');
const counters = require('../../src/core/counters');
const settings = require('../../src/core/settings');
const notify = require('../../src/core/notify');
const receivables = require('../../src/modules/receivables/service');
const { Notification } = require('../../src/modules/notifications/models');

let app; let w; let lister; let A; let A2; let agent; let G; let manager; let team;
const FIN = ['deals.verify', 'receivables.manage', 'invoices.issue', 'integrations.manage', 'partners.manage', 'contacts.view'];

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  // referredBy is immutable in the schema (lifetime attribution), so it is written straight to the collection.
  await User.collection.updateOne({ _id: lister.user._id }, { $set: { billing: { name: 'Rahul Secret Owner', address: 'Baner, Pune', state: 'Maharashtra' }, referredBy: 'LISTREF1' } });
  A = h.bearer((await h.userWithToken('admin', { permissions: FIN })).token);
  A2 = h.bearer((await h.userWithToken('admin', { permissions: FIN })).token);
  agent = await h.userWithToken('agent');
  G = h.bearer(agent.token);
  manager = await h.userWithToken('manager', { permissions: ['leads.view_all'] });
  team = await Team.create({ name: 'Deals Team', managerIds: [manager.user._id], members: [{ agentId: agent.user._id }], territories: { cities: ['Pune'] } });
});
afterAll(() => mongoose.disconnect());

let n = 0;
const pdf = () => { n += 1; return Buffer.from(`%PDF-1.4\n% receipt ${n} ${Date.now()} ${Math.random()}\n%%EOF`); };

async function upload(purpose, buffer = pdf()) {
  const r = await request(app).post(`/api/uploads?purpose=${purpose}`).set(G).attach('file', buffer, { filename: 'doc.pdf', contentType: 'application/pdf' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.id;
}

async function world({ owner = lister, purpose = 'sale', amount = 8000000, percent = 1.5 } = {}) {
  const p = await liveListing(w, owner, { purpose, amount });
  await Agreement.create({ agreementNo: await counters.agreementNo(), propertyId: p._id, listerId: owner.user._id, version: 1, commissionPercent: percent, basis: purpose === 'rent' ? 'annual_rent' : 'sale_price', textSnapshot: 'Agreement', textHash: 'hash', status: 'accepted', effectiveFrom: new Date(Date.now() - 30 * 86400000) });
  return p;
}

async function leadOn(p, { visit = true } = {}) {
  n += 1;
  const lead = await Lead.create({
    leadNo: await counters.leadNo(), buyer: { name: 'Asha Buyer', phone: `+9198765${String(10000 + n).slice(-5)}`, email: `buyer${n}@example.com` }, propertyId: p._id,
    stage: 'negotiation', assignedTo: agent.user._id, teamId: team._id, sources: ['enquiry'], referralCode: 'AB12CD34',
  });
  if (visit) await SiteVisit.create({ visitNo: await counters.visitNo(), leadId: lead._id, propertyId: p._id, agentId: agent.user._id, scheduledAt: new Date(Date.now() - 86400000), status: 'completed' });
  return lead;
}

const today = () => new Date().toISOString();
async function draft(lead, body = {}) {
  n += 1;
  const r = await request(app).post('/api/agent/deals').set(G).send({ leadId: String(lead._id), agreedPrice: 8000000, bookingAmount: 200000, bookingDate: today(), paymentMode: 'bank_transfer', paymentReference: `UTR${Date.now()}${n}`, ...body });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data;
}

async function withDocs(deal, receiptBuffer) {
  await request(app).post(`/api/agent/deals/${deal._id}/documents`).set(G).send({ fileId: await upload('receipt', receiptBuffer), kind: 'receipt', label: 'Token receipt' }).expect(201);
  await request(app).post(`/api/agent/deals/${deal._id}/documents`).set(G).send({ fileId: await upload('agreement_doc'), kind: 'agreement', label: 'Booking form' }).expect(201);
}

async function submitted(opts = {}) {
  const p = opts.p || await world(opts);
  const lead = await leadOn(p);
  const deal = await draft(lead, opts.body);
  await withDocs(deal, opts.receipt);
  const s = await request(app).post(`/api/agent/deals/${deal._id}/submit`).set(G);
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  return { p, lead, deal: s.body.data };
}

async function verified(opts = {}) {
  const x = await submitted(opts);
  await request(app).post(`/api/admin/deals/${x.deal._id}/claim`).set(A).expect(200);
  const v = await request(app).post(`/api/admin/deals/${x.deal._id}/decision`).set(A).send({ decision: 'verify', checklist: { receiptMatches: true } });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  return { ...x, deal: v.body.data };
}

describe('[H][agent] RE-H-01..03 Deal creation and closure gates', () => {
  test('submitting without a completed site visit returns 422; with gates passed the lead moves to booking', async () => {
    const p = await world();
    const lead = await leadOn(p, { visit: false });
    const deal = await draft(lead);
    expect(deal).toMatchObject({ status: 'draft', dealType: 'sale', commissionPercent: 1.5 });
    const noVisit = await request(app).post(`/api/agent/deals/${deal._id}/submit`).set(G);
    expect(noVisit.status).toBe(422);
    expect(noVisit.body.error.message).toBe('A completed site visit is required');
    await SiteVisit.create({ visitNo: await counters.visitNo(), leadId: lead._id, propertyId: p._id, scheduledAt: new Date(Date.now() - 3600000), status: 'completed' });
    const noDocs = await request(app).post(`/api/agent/deals/${deal._id}/submit`).set(G);
    expect(noDocs.status).toBe(422);
    expect(JSON.stringify(noDocs.body.error.details)).toMatch(/receipt/);
    await withDocs(deal);
    const ok = await request(app).post(`/api/agent/deals/${deal._id}/submit`).set(G).expect(200);
    expect(ok.body.data.status).toBe('submitted');
    expect((await Lead.findById(lead._id)).stage).toBe('booking');
    // One open deal per lead.
    expect((await request(app).post('/api/agent/deals').set(G).send({ leadId: String(lead._id) })).body.error.code).toBe('OPEN_DEAL_EXISTS');
  });

  test('RE-H-09 commission for INR 80,00,000 at 1.5% is INR 1,20,000 with GST INR 21,600 (CGST + SGST intra-state)', async () => {
    const { deal } = await submitted();
    expect(deal.commissionAmount).toBe(120000 * 100);
    expect(deal.gstAmount).toBe(21600 * 100);
    expect(deal.gst).toMatchObject({ interState: false, cgst: 10800 * 100, sgst: 10800 * 100, igst: 0 });
  });

  test('inter-state lister billing gets IGST 18%; rent basis is monthly rent x 12', async () => {
    const other = await fx2.verifiedLister('owner');
    await User.updateOne({ _id: other.user._id }, { $set: { billing: { name: 'Bengaluru Owner', state: 'Karnataka' } } });
    const p = await world({ owner: other, purpose: 'rent', amount: 40000, percent: 8.33 });
    const lead = await leadOn(p);
    const d = await draft(lead, { agreedPrice: undefined, monthlyRent: 40000, bookingAmount: 80000 });
    expect(d.dealType).toBe('rent');
    expect(d.commissionAmount).toBe(Math.round(480000 * 0.0833) * 100); // INR 39,984
    expect(d.gst).toMatchObject({ interState: true, cgst: 0, sgst: 0, igst: d.gstAmount });
  });

  test('a price more than 30% from the listed price needs a justification; more than 50% is blocked', async () => {
    const p = await world();
    const lead = await leadOn(p);
    const d = await draft(lead, { agreedPrice: 5000000 }); // 37.5% below
    await withDocs(d);
    const r = await request(app).post(`/api/agent/deals/${d._id}/submit`).set(G);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.error.details)).toMatch(/justification/);
    await request(app).patch(`/api/agent/deals/${d._id}`).set(G).send({ agreedPrice: 3500000 }).expect(200);
    expect((await request(app).post(`/api/agent/deals/${d._id}/submit`).set(G)).body.error.message).toBe('Price deviation above 50%');
    await request(app).patch(`/api/agent/deals/${d._id}`).set(G).send({ agreedPrice: 5000000, justification: 'Distress sale, owner relocating abroad next month' }).expect(200);
    const ok = await request(app).post(`/api/agent/deals/${d._id}/submit`).set(G).expect(200);
    expect(ok.body.data.warnings[0].code).toBe('PRICE_DEVIATION');
  });

  test('acceptance 7: a deal from an accepted offer is prefilled; changing the price without a note returns 422', async () => {
    const p = await world();
    const lead = await leadOn(p);
    const offer = await Offer.create({ offerNo: await counters.offerNo(), leadId: lead._id, propertyId: p._id, listerId: lister.user._id, agentId: agent.user._id, status: 'accepted',
      rounds: [{ n: 1, by: 'agent', kind: 'offer', amount: 7900000 * 100, terms: { token: 150000 * 100 } }, { n: 2, by: 'lister', kind: 'accept', amount: 7900000 * 100 }] });
    const bad = await request(app).post('/api/agent/deals').set(G).send({ leadId: String(lead._id), offerId: String(offer._id), agreedPrice: 7800000 });
    expect(bad.status).toBe(422);
    const r = await request(app).post('/api/agent/deals').set(G).send({ leadId: String(lead._id), offerId: String(offer._id) }).expect(201);
    expect(r.body.data).toMatchObject({ agreedPrice: 7900000 * 100, bookingAmount: 150000 * 100 });
    expect(String((await Offer.findById(offer._id)).dealId)).toBe(r.body.data._id);
  });
});

describe('[H][system] RE-H-05 Duplicate receipt detection', () => {
  test('the same receipt file in another deal blocks submission with that deal number (409)', async () => {
    const buf = pdf();
    const first = await submitted({ receipt: buf });
    const p = await world();
    const lead = await leadOn(p);
    const d = await draft(lead);
    await withDocs(d, buf);
    const r = await request(app).post(`/api/agent/deals/${d._id}/submit`).set(G);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DUPLICATE_RECEIPT');
    expect(r.body.error.message).toContain(first.deal.dealNo);
  });

  test('the same payment mode and reference number also blocks', async () => {
    const first = await submitted({ body: { paymentMode: 'upi', paymentReference: 'UPI-SAME-REF-1' } });
    const p = await world();
    const lead = await leadOn(p);
    const d = await draft(lead, { paymentMode: 'upi', paymentReference: 'UPI-SAME-REF-1' });
    await withDocs(d);
    const r = await request(app).post(`/api/agent/deals/${d._id}/submit`).set(G);
    expect(r.body.error.details.deals).toEqual([first.deal.dealNo]);
  });
});

describe('[H][admin] RE-H-04/06 Verification', () => {
  test('claim lock: deciding without a claim fails, a second admin cannot claim, release frees it', async () => {
    const { deal } = await submitted();
    expect((await request(app).post(`/api/admin/deals/${deal._id}/decision`).set(A).send({ decision: 'verify' })).body.error.code).toBe('NOT_CLAIMED');
    await request(app).post(`/api/admin/deals/${deal._id}/claim`).set(A).expect(200);
    expect((await request(app).post(`/api/admin/deals/${deal._id}/claim`).set(A2)).body.error.code).toBe('CLAIMED_BY_OTHER');
    await request(app).post(`/api/admin/deals/${deal._id}/release`).set(A).expect(200);
    await request(app).post(`/api/admin/deals/${deal._id}/claim`).set(A2).expect(200);
    const detail = await request(app).get(`/api/admin/deals/${deal._id}`).set(A2).expect(200);
    expect(detail.body.data.checklist).toMatchObject({ completedVisit: true, receipts: 1, agreements: 1, duplicateReceipts: [] });
    const doc = detail.body.data.documents[0];
    const url = await request(app).get(`/api/admin/deals/${deal._id}/documents/${doc._id}`).set(A2).expect(200);
    expect(url.body.data.url).toMatch(/^http/);
  });

  test('acceptance 3: verify sets lead closed_won, listing sold, one receivable and one deal.closed event', async () => {
    const before = await Outbox.countDocuments({ type: 'deal.closed' });
    const { deal, lead, p } = await verified();
    expect(deal.status).toBe('verified');
    expect((await Lead.findById(lead._id)).stage).toBe('closed_won');
    expect((await Property.findById(p._id)).status).toBe('sold');
    const recs = await Receivable.find({ dealId: deal._id });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ status: 'pending_invoice', commissionAmount: 12000000, gstAmount: 2160000, totalDue: 14160000 });
    const events = await Outbox.find({ type: 'deal.closed', aggregateId: deal._id });
    expect(events).toHaveLength(1);
    expect(await Outbox.countDocuments({ type: 'deal.closed' })).toBe(before + 1);
    const data = events[0].payload.data;
    expect(data).toMatchObject({ dealNo: deal.dealNo, verified: true, agreedPrice: 8000000, commissionAmount: 120000, commissionPercent: 1.5, receiptsCount: 1, currency: 'INR' });
    expect(data.buyer.referralCode).toBe('AB12CD34');
    expect(data.lister.referralCode).toBe('LISTREF1');
    expect(events[0].payload.platform).toBe('realestate');
  });

  test('N acceptance 4: the outbox payload has no phone, email, name or address', async () => {
    const { deal } = await verified();
    const e = await Outbox.findOne({ aggregateId: deal._id, type: 'deal.closed' }).lean();
    const raw = JSON.stringify(e.payload);
    expect(raw).not.toMatch(/phone|email|"name"|address|Asha|Rahul|\+91|@example/i);
  });

  test('acceptance 4: no deal.closed for draft, submitted, returned or rejected deals', async () => {
    const s = await submitted();
    await request(app).post(`/api/admin/deals/${s.deal._id}/claim`).set(A).expect(200);
    await request(app).post(`/api/admin/deals/${s.deal._id}/decision`).set(A).send({ decision: 'return', comment: 'Receipt is blurred, upload a clearer copy' }).expect(200);
    expect((await Deal.findById(s.deal._id)).status).toBe('returned');
    expect((await Lead.findById(s.lead._id)).stage).toBe('negotiation');
    const r = await submitted();
    await request(app).post(`/api/admin/deals/${r.deal._id}/claim`).set(A).expect(200);
    expect((await request(app).post(`/api/admin/deals/${r.deal._id}/decision`).set(A).send({ decision: 'reject' })).status).toBe(422);
    await request(app).post(`/api/admin/deals/${r.deal._id}/decision`).set(A).send({ decision: 'reject', reason: 'Fake receipt' }).expect(200);
    expect(await Outbox.countDocuments({ aggregateId: { $in: [s.deal._id, r.deal._id] } })).toBe(0);
    expect(await Receivable.countDocuments({ dealId: { $in: [s.deal._id, r.deal._id] } })).toBe(0);
  });

  test('RE-H-07 returned deals are edited and resubmitted (count +1)', async () => {
    const s = await submitted();
    await request(app).post(`/api/admin/deals/${s.deal._id}/claim`).set(A).expect(200);
    await request(app).post(`/api/admin/deals/${s.deal._id}/decision`).set(A).send({ decision: 'return', comment: 'Booking amount does not match receipt' }).expect(200);
    await request(app).patch(`/api/agent/deals/${s.deal._id}`).set(G).send({ bookingAmount: 250000 }).expect(200);
    const r = await request(app).post(`/api/agent/deals/${s.deal._id}/submit`).set(G).expect(200);
    expect(r.body.data).toMatchObject({ status: 'submitted', resubmissionCount: 1 });
  });

  test('idempotent verify: the same Idempotency-Key replays; two deals on one sale listing -> the second gets 409', async () => {
    const p = await world();
    const a = await submitted({ p });
    const b = await submitted({ p });
    await request(app).post(`/api/admin/deals/${a.deal._id}/claim`).set(A).expect(200);
    await request(app).post(`/api/admin/deals/${a.deal._id}/decision`).set(A).set('Idempotency-Key', 'k-1').send({ decision: 'verify' }).expect(200);
    const again = await request(app).post(`/api/admin/deals/${a.deal._id}/decision`).set(A).set('Idempotency-Key', 'k-1').send({ decision: 'verify' }).expect(200);
    expect(again.body.data.replayed).toBe(true);
    expect(await Outbox.countDocuments({ aggregateId: a.deal._id })).toBe(1);
    await request(app).post(`/api/admin/deals/${b.deal._id}/claim`).set(A).expect(200);
    const second = await request(app).post(`/api/admin/deals/${b.deal._id}/decision`).set(A).send({ decision: 'verify' });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe('Property already sold');
    expect(await Receivable.countDocuments({ dealId: b.deal._id })).toBe(0); // the transaction rolled back
  });

  test('cash above INR 1,99,999 warns on submit and needs a verification note', async () => {
    const s = await submitted({ body: { paymentMode: 'cash', paymentReference: undefined, bookingAmount: 250000 } });
    expect(s.deal.warnings.map((x) => x.code)).toContain('CASH_269ST');
    await request(app).post(`/api/admin/deals/${s.deal._id}/claim`).set(A).expect(200);
    expect((await request(app).post(`/api/admin/deals/${s.deal._id}/decision`).set(A).send({ decision: 'verify' })).status).toBe(422);
    await request(app).post(`/api/admin/deals/${s.deal._id}/decision`).set(A).send({ decision: 'verify', note: 'Cash deposit slip checked with bank statement' }).expect(200);
  });

  test('managers see their team deals in the queue; agents see only their own', async () => {
    await submitted();
    const q = await request(app).get('/api/admin/deals').set(h.bearer(manager.token)).expect(200);
    expect(q.body.data.length).toBeGreaterThan(0);
    expect(q.body.data[0]).toHaveProperty('slaDueAt');
    const other = await h.userWithToken('agent');
    const mine = await request(app).get('/api/agent/deals').set(h.bearer(other.token)).expect(200);
    expect(mine.body.data).toHaveLength(0);
  });
});

describe('[H][admin] RE-H-08 Reversal', () => {
  test('acceptance 6: reversing writes deal.reversed, restores the listing to live and cancels the receivable with a credit note', async () => {
    const v = await verified();
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    const dr = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({}).expect(201);
    await request(app).post(`/api/admin/invoices/${dr.body.data.invoice._id}/issue`).set(A).send({}).expect(200);
    const r = await request(app).post(`/api/admin/deals/${v.deal._id}/reverse`).set(A).send({ reason: 'Buyer cancelled the booking' }).expect(200);
    expect(r.body.data.status).toBe('reversed');
    expect((await Property.findById(v.p._id)).status).toBe('live');
    expect((await Lead.findById(v.lead._id)).stage).toBe('negotiation');
    const after = await Receivable.findById(rec._id);
    expect(after.status).toBe('cancelled');
    expect(after.invoices[0]).toMatchObject({ status: 'cancelled' });
    expect(after.invoices[0].creditNote.no).toMatch(/^RE\/CN\//);
    const ev = await Outbox.findOne({ aggregateId: v.deal._id, type: 'deal.reversed' });
    expect(ev.payload.data).toMatchObject({ dealNo: v.deal.dealNo, reason: 'Buyer cancelled the booking' });
    expect((await request(app).post(`/api/admin/deals/${v.deal._id}/reverse`).set(A).send({ reason: 'again please' })).status).toBe(409);
  });

  test('a receivable with payments becomes disputed on reversal', async () => {
    const v = await verified();
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    const dr = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({}).expect(201);
    await request(app).post(`/api/admin/invoices/${dr.body.data.invoice._id}/issue`).set(A).send({}).expect(200);
    await request(app).post(`/api/admin/receivables/${rec._id}/payments`).set(A).send({ amount: 50000, mode: 'bank_transfer', reference: 'UTR-P1' }).expect(201);
    await request(app).post(`/api/admin/deals/${v.deal._id}/reverse`).set(A).send({ reason: 'Cheque bounced', leadOutcome: 'closed_lost' }).expect(200);
    expect((await Receivable.findById(rec._id)).status).toBe('disputed');
    expect((await Lead.findById(v.lead._id)).stage).toBe('closed_lost');
  });
});

describe('[I][admin] RE-I-01..09 Receivables and invoices', () => {
  test('missing billing details block the draft invoice with "Billing name required"', async () => {
    const other = await fx2.verifiedLister('owner');
    const v = await verified({ owner: other });
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    const r = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({});
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe('Billing name required');
  });

  test('acceptance 3/4: invoice with CGST + SGST, payments up to the total set paid, overpayment refused', async () => {
    const v = await verified();
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    expect((await request(app).post(`/api/admin/receivables/${rec._id}/payments`).set(A).send({ amount: 100, mode: 'upi' })).body.error.code).toBe('NOT_COLLECTING');
    const dr = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({}).expect(201);
    expect(dr.body.data.invoice).toMatchObject({ status: 'draft', taxable: 12000000, cgst: 1080000, sgst: 1080000, igst: 0, total: 14160000 });
    expect((await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({ amount: 1 })).status).toBe(409); // fully invoiced
    const is = await request(app).post(`/api/admin/invoices/${dr.body.data.invoice._id}/issue`).set(A).send({}).expect(200);
    expect(is.body.data.invoice.invoiceNo).toMatch(/^RE\/INV\/\d{4}-\d{2}\/\d{5}$/);
    expect(is.body.data.status).toBe('invoiced');
    const pdfRes = await request(app).get(`/api/admin/invoices/${dr.body.data.invoice._id}/pdf`).set(A).expect(200);
    expect(pdfRes.headers['content-type']).toBe('application/pdf');
    expect((await request(app).post(`/api/admin/receivables/${rec._id}/payments`).set(A).send({ amount: 141601, mode: 'bank_transfer' })).status).toBe(422);
    const part = await request(app).post(`/api/admin/receivables/${rec._id}/payments`).set(A).send({ amount: 100000, tds: 12000, mode: 'bank_transfer', reference: 'UTR1' }).expect(201);
    expect(part.body.data.status).toBe('partially_paid');
    const full = await request(app).post(`/api/admin/receivables/${rec._id}/payments`).set(A).send({ amount: 29600, mode: 'upi', reference: 'UPI2' }).expect(201);
    expect(full.body.data).toMatchObject({ status: 'paid', outstanding: 0 });
    expect(await Notification.exists({ eventKey: 'payment.confirmed', userId: lister.user._id })).toBeTruthy();
  });

  test('acceptance 2: invoice numbers stay gapless under parallel issuance', async () => {
    const drafts = [];
    for (let i = 0; i < 5; i += 1) {
      const v = await verified();
      const rec = await Receivable.findOne({ dealId: v.deal._id });
      drafts.push((await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({}).expect(201)).body.data.invoice._id);
    }
    const res = await Promise.all(drafts.map((id) => request(app).post(`/api/admin/invoices/${id}/issue`).set(A).send({})));
    res.forEach((r) => expect(r.status).toBe(200));
    const nums = res.map((r) => Number(r.body.data.invoice.invoiceNo.split('/').pop())).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i += 1) expect(nums[i]).toBe(nums[i - 1] + 1);
    expect(new Set(nums).size).toBe(5);
  });

  test('acceptance 5: a past due date moves the receivable to overdue on the daily job and sends a reminder', async () => {
    const v = await verified();
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    const dr = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({}).expect(201);
    await request(app).post(`/api/admin/invoices/${dr.body.data.invoice._id}/issue`).set(A).send({}).expect(200);
    const past = new Date(Date.now() - 7 * 86400000);
    await Receivable.updateOne({ _id: rec._id }, { $set: { dueDate: past, 'invoices.0.dueDate': past } });
    const out = await receivables.runDaily(new Date());
    expect(out.overdue).toBeGreaterThanOrEqual(1);
    const after = await Receivable.findById(rec._id);
    expect(after.status).toBe('overdue');
    expect(after.remindersSent.some((x) => x.kind.startsWith('due7'))).toBe(true);
    const ageing = await request(app).get('/api/admin/receivables').set(A).query({ status: 'overdue' }).expect(200);
    expect(ageing.body.data.some((x) => x._id === String(rec._id))).toBe(true);
  });

  test('RE-I-05/07 lister proof (reject, then confirm actual amount), dispute pauses collection, resolve, write-off', async () => {
    const v = await verified();
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    const dr = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({ amount: 60000 }).expect(201);
    const invId = dr.body.data.invoice._id;
    await request(app).post(`/api/admin/invoices/${invId}/issue`).set(A).send({}).expect(200);
    const L = lister.t;
    const mine = await request(app).get('/api/lister/invoices').set(L).expect(200);
    expect(mine.body.data.some((x) => x._id === invId)).toBe(true);
    expect(JSON.stringify(mine.body.data)).not.toMatch(/Asha Buyer|buyer\d+@example/);
    const file = await request(app).post('/api/uploads?purpose=payment_proof').set(L).attach('file', pdf(), { filename: 'proof.pdf', contentType: 'application/pdf' }).expect(201);
    const proof = await request(app).post(`/api/lister/invoices/${invId}/payment-proof`).set(L).send({ fileId: file.body.data.id, amount: 70800, date: today(), mode: 'bank_transfer', reference: 'UTRL1' }).expect(201);
    await request(app).post(`/api/admin/receivables/${rec._id}/payment-proofs/${proof.body.data._id}/decision`).set(A).send({ decision: 'reject', reason: 'No such credit in our bank statement' }).expect(200);
    const proof2 = await request(app).post(`/api/lister/invoices/${invId}/payment-proof`).set(L).send({ fileId: file.body.data.id, amount: 70800, date: today(), mode: 'bank_transfer', reference: 'UTRL2' }).expect(201);
    const conf = await request(app).post(`/api/admin/receivables/${rec._id}/payment-proofs/${proof2.body.data._id}/decision`).set(A).send({ decision: 'confirm', amount: 50000 }).expect(200);
    expect(conf.body.data).toMatchObject({ status: 'partially_paid', paidTotal: 5000000 });
    await request(app).post(`/api/lister/invoices/${invId}/dispute`).set(L).send({ reason: 'Commission percent on this invoice looks wrong' }).expect(200);
    expect((await request(app).post(`/api/admin/receivables/${rec._id}/payments`).set(A).send({ amount: 10, mode: 'upi' })).body.error.code).toBe('DISPUTED');
    const res = await request(app).post(`/api/admin/receivables/${rec._id}/dispute/resolve`).set(A).send({ note: 'Explained the agreement version to the lister' }).expect(200);
    expect(res.body.data.status).toBe('partially_paid');
    const wo = await request(app).post(`/api/admin/receivables/${rec._id}/write-off`).set(A).send({ reason: 'Settled the rest in negotiation with the builder' }).expect(200);
    expect(wo.body.data).toMatchObject({ status: 'written_off', outstanding: 0 });
  });

  test('cancelling an issued invoice creates a credit note; lister PDF of a draft is not visible', async () => {
    const v = await verified();
    const rec = await Receivable.findOne({ dealId: v.deal._id });
    const dr = await request(app).post(`/api/admin/receivables/${rec._id}/invoices`).set(A).send({}).expect(201);
    const invId = dr.body.data.invoice._id;
    expect((await request(app).get(`/api/lister/invoices/${invId}`).set(lister.t)).status).toBe(404);
    await request(app).post(`/api/admin/invoices/${invId}/issue`).set(A).send({}).expect(200);
    const c = await request(app).post(`/api/admin/invoices/${invId}/cancel`).set(A).send({ reason: 'Wrong billing name' }).expect(200);
    expect(c.body.data.status).toBe('pending_invoice');
    expect(c.body.data.invoice.creditNote.no).toMatch(/^RE\/CN\//);
    const csv = await request(app).get('/api/admin/receivables/export').set(A).expect(200);
    expect(csv.text.split('\n')[0]).toMatch(/^receivableNo,dealNo/);
  });
});

describe('[N][admin] RE-N-08/09 Outbox monitor and referral codes', () => {
  test('list, retry and mark dead; jobs list', async () => {
    const v = await verified();
    const ev = await Outbox.findOne({ aggregateId: v.deal._id });
    const list = await request(app).get('/api/admin/outbox').set(A).query({ type: 'deal.closed' }).expect(200);
    expect(list.body.meta.counts).toBeDefined();
    const one = await request(app).get(`/api/admin/outbox/${ev._id}`).set(A).expect(200);
    expect(one.body.data.payload.type).toBe('deal.closed');
    await request(app).post(`/api/admin/outbox/${ev._id}/mark-dead`).set(A).send({ reason: 'Test' }).expect(200);
    const rt = await request(app).post(`/api/admin/outbox/${ev._id}/retry`).set(A).expect(200);
    expect(rt.body.data.status).toBe('pending');
    await request(app).get('/api/admin/jobs').set(A).expect(200);
    expect((await request(app).get('/api/admin/outbox').set(G)).status).toBe(403);
  });

  test('every user gets a stable referral code and share link', async () => {
    const a = await request(app).get('/api/me/referral').set(G).expect(200);
    expect(a.body.data.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(a.body.data.shareLink).toContain(`?ref=${a.body.data.code}`);
    const b = await request(app).get('/api/me/referral').set(G).expect(200);
    expect(b.body.data.code).toBe(a.body.data.code);
  });
});

describe('[H][agent] RE-H-10..12 Partner services (Could)', () => {
  test('a home-loan referral needs consent; the partner email has no lister data', async () => {
    await settings.set('partners.loanReferralEnabled', true);
    const partner = await request(app).post('/api/admin/partners').set(A).send({ name: 'Test Bank', type: 'bank', cities: ['Pune'], contact: { email: 'loans@bank.example' } }).expect(201);
    const p = await world();
    const lead = await leadOn(p);
    const no = await request(app).post(`/api/agent/leads/${lead._id}/referrals`).set(G).send({ partnerId: partner.body.data._id, loanAmount: 6000000 });
    expect(no.status).toBe(422);
    const r = await request(app).post(`/api/agent/leads/${lead._id}/referrals`).set(G).send({ partnerId: partner.body.data._id, loanAmount: 6000000, consent: true }).expect(201);
    expect(r.body.data.refNo).toMatch(/^PRF-\d{4}-\d{5}$/);
    const mail = notify.sent.find((m) => m.to === 'loans@bank.example');
    expect(mail.text).toContain('Asha Buyer');
    expect(mail.text).not.toMatch(/Rahul|9800000001|secret\.owner|Green Park|Flat 504/);
    expect((await request(app).post(`/api/agent/leads/${lead._id}/referrals`).set(G).send({ partnerId: partner.body.data._id, loanAmount: 6000000, consent: true })).body.error.code).toBe('REFERRAL_EXISTS');
    const up = await request(app).patch(`/api/admin/partner-referrals/${r.body.data._id}`).set(A).send({ status: 'contacted' }).expect(200);
    expect(up.body.data.status).toBe('contacted');
    expect((await request(app).patch(`/api/admin/partner-referrals/${r.body.data._id}`).set(A).send({ status: 'referred' })).status).toBe(409);
    expect(await Partner.countDocuments()).toBe(1);
  });
});
