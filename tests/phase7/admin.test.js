// Phase 7 - admin, finance and reporting gaps: reported listing -> broker flag
// (RE-E-13 / RE-F-06), photo QA gallery override (RE-A-20), partial write-off
// (RE-I-07), audit / login CSV exports (RE-O-05/06), integration status cards
// (RE-S-ADM-30), dashboard tiles (RE-S-ADM-01), partner agreements and loan
// amounts (RE-H-10), the commission preview (RE-H-09) and lister range stats
// (RE-O-08).
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx2 = require('../phase2/fixtures');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead, SiteVisit, Offer } = require('../../src/modules/leads/models');
const { Property, VerificationSession } = require('../../src/modules/listings/models');
const { Agreement } = require('../../src/modules/approvals/models');
const { Deal, PartnerReferral } = require('../../src/modules/deals/models');
const { Receivable } = require('../../src/modules/receivables/models');
const { Team } = require('../../src/modules/teams/models');
const { BrokerFlag } = require('../../src/modules/kyc/models');
const { ListingReport, Shortlist } = require('../../src/modules/search/models');
const { LoginHistory } = require('../../src/modules/auth/models');
const { AuditLog } = require('../../src/core/audit');
const { Job } = require('../../src/core/jobs');
const { Outbox } = require('../../src/core/outbox');
const storage = require('../../src/core/storage');
const counters = require('../../src/core/counters');
const env = require('../../src/config/env');

let app; let w; let lister; let S; let superadmin; let agent; let G; let otherAgent; let manager; let team;
const DAY = 86400000;
const FIN = ['receivables.manage', 'invoices.issue', 'partners.manage'];

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  superadmin = await h.userWithToken('superadmin', { name: 'Root Admin' });
  S = h.bearer(superadmin.token);
  agent = await h.userWithToken('agent');
  G = h.bearer(agent.token);
  otherAgent = await h.userWithToken('agent');
  manager = await h.userWithToken('manager', { permissions: ['dashboard.view', 'reports.view'] });
  team = await Team.create({ name: 'Phase 7 team', managerIds: [manager.user._id], members: [{ agentId: agent.user._id }] });
});
afterAll(() => mongoose.disconnect());

let n = 0;
async function leadOn(p, over = {}) {
  n += 1;
  return Lead.create({
    leadNo: await counters.leadNo(), buyer: { name: `P7 Buyer ${n}`, phone: `+9198111${String(10000 + n).slice(-5)}`, email: `p7b${n}@example.com` }, propertyId: p._id,
    stage: 'negotiation', assignedTo: agent.user._id, teamId: team._id, sources: ['enquiry'], ...over,
  });
}

async function report(p, reason = 'broker') {
  return ListingReport.create({ reportNo: await counters.reportNo(), propertyId: p._id, reporter: { ipHash: `ip${Math.random()}` }, reason, details: 'Asked for a brokerage fee on the call' });
}

const pdf = (tag) => Buffer.from(`%PDF-1.4\n% ${tag} ${Date.now()} ${Math.random()}\n%%EOF`);
async function upload(token, purpose, tag = purpose) {
  const r = await request(app).post(`/api/uploads?purpose=${purpose}`).set(h.bearer(token)).attach('file', pdf(tag), { filename: 'doc.pdf', contentType: 'application/pdf' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.id;
}

// ---------------------------------------------------------------- 1. reported listings -> broker flag

describe('[E][admin] RE-E-13 reported listing raises a broker flag', () => {
  test('raise_broker_flag opens a "reports" flag with the report as evidence; flag:true with pause adds to the same flag', async () => {
    const p1 = await liveListing(w, lister);
    const r1 = await report(p1);
    const res = await request(app).patch(`/api/admin/listing-reports/${r1._id}`).set(S).send({ action: 'raise_broker_flag', note: 'Lister asked the buyer for brokerage' }).expect(200);
    expect(res.body.data).toMatchObject({ status: 'actioned', action: 'raise_broker_flag' });
    expect(res.body.data.brokerFlag.flagNo).toMatch(/^BF/);
    const flag = await BrokerFlag.findById(res.body.data.brokerFlag._id).lean();
    expect(flag).toMatchObject({ rule: 'reports', status: 'open' });
    expect(String(flag.listerId)).toBe(String(lister.user._id));
    expect(flag.evidence.adminReports).toHaveLength(1);
    expect(flag.evidence.adminReports[0]).toMatchObject({ reportNo: r1.reportNo, reason: 'broker', listingNo: p1.listingNo });
    expect((await Property.findById(p1._id)).status).toBe('live'); // a flag alone does not touch the listing

    const p2 = await liveListing(w, lister);
    const r2 = await report(p2);
    const res2 = await request(app).patch(`/api/admin/listing-reports/${r2._id}`).set(S).send({ action: 'pause', flag: true, note: 'Second broker report, pausing' }).expect(200);
    expect(String(res2.body.data.brokerFlag._id)).toBe(String(flag._id)); // one open flag per lister and rule
    expect((await Property.findById(p2._id)).status).toBe('paused');
    const after = await BrokerFlag.findById(flag._id).lean();
    expect(after.evidence.adminReports.map((x) => x.reportNo)).toEqual([r1.reportNo, r2.reportNo]);
    expect(await AuditLog.countDocuments({ action: 'broker_flag.from_report', entityId: flag._id })).toBe(2);
  });

  test('a dismissed report cannot raise a flag; a plain ask_fix raises none', async () => {
    const p = await liveListing(w, lister);
    const r = await report(p, 'wrong_info');
    expect((await request(app).patch(`/api/admin/listing-reports/${r._id}`).set(S).send({ action: 'dismiss', flag: true, note: 'Nothing wrong' })).status).toBe(400);
    const before = await BrokerFlag.countDocuments();
    const ok = await request(app).patch(`/api/admin/listing-reports/${r._id}`).set(S).send({ action: 'ask_fix', note: 'Please correct the floor number' }).expect(200);
    expect(ok.body.data.brokerFlag).toBeUndefined();
    expect(await BrokerFlag.countDocuments()).toBe(before);
  });
});

// ---------------------------------------------------------------- 2. photo QA gallery override

describe('[A][admin] RE-A-20 photo QA addToGallery override', () => {
  async function session(p, addToGallery) {
    const files = await storage.FileModel.create([1, 2, 3, 4].map((i) => ({ ownerId: lister.user._id, purpose: 'verification_photo', provider: 'local', key: `test/vp-${p._id}-${i}.jpg`, visibility: 'private', mime: 'image/jpeg' })));
    return VerificationSession.create({
      sessionNo: await counters.verificationNo(), propertyId: p._id, tokenHash: `hash-${p._id}-${Math.random()}`, expiresAt: new Date(Date.now() + DAY), status: 'pending_review', addToGallery,
      gps: { lat: 18.56, lng: 73.78, accuracy: 10, distanceM: 20 }, photos: files.map((f) => ({ fileId: f._id, capturedAt: new Date(), lat: 18.56, lng: 73.78 })),
    });
  }

  test('approve with addToGallery: true adds the photos although the lister said no; false overrides a yes', async () => {
    const p = await liveListing(w, lister);
    const s = await session(p, false);
    await request(app).post(`/api/admin/verification/photo-sessions/${s._id}/claim`).set(S).expect(200);
    const d = await request(app).post(`/api/admin/verification/photo-sessions/${s._id}/decision`).set(S).send({ decision: 'approve', addToGallery: true }).expect(200);
    expect(d.body.data).toMatchObject({ status: 'approved', addToGallery: true });
    const after = await Property.findById(p._id).lean();
    expect(after.media.photos.filter((x) => x.caption === 'Verified photo')).toHaveLength(4);
    const log = await AuditLog.findOne({ action: 'verification.approve', entityId: p._id }).lean();
    expect(log.after).toMatchObject({ addToGallery: true, listerChoice: false });

    const p2 = await liveListing(w, lister);
    const s2 = await session(p2, true);
    await request(app).post(`/api/admin/verification/photo-sessions/${s2._id}/claim`).set(S).expect(200);
    await request(app).post(`/api/admin/verification/photo-sessions/${s2._id}/decision`).set(S).send({ decision: 'approve', addToGallery: false }).expect(200);
    expect((await Property.findById(p2._id).lean()).media.photos.filter((x) => x.caption === 'Verified photo')).toHaveLength(0);
    expect((await VerificationSession.findById(s2._id)).addToGallery).toBe(false);
  });

  test('without addToGallery the lister choice stands', async () => {
    const p = await liveListing(w, lister);
    const s = await session(p, true);
    await request(app).post(`/api/admin/verification/photo-sessions/${s._id}/claim`).set(S).expect(200);
    await request(app).post(`/api/admin/verification/photo-sessions/${s._id}/decision`).set(S).send({ decision: 'approve' }).expect(200);
    expect((await Property.findById(p._id).lean()).media.photos.filter((x) => x.caption === 'Verified photo')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------- 3. partial write-off

async function receivable(over = {}) {
  const p = await liveListing(w, lister);
  const lead = await leadOn(p);
  const deal = await Deal.create({ dealNo: await counters.dealNo(), leadId: lead._id, propertyId: p._id, agentId: agent.user._id, teamId: team._id, listerId: lister.user._id, dealType: 'sale', status: 'verified', commissionAmount: 100000, gstAmount: 18000, submittedAt: new Date(), review: { verifiedAt: new Date() } });
  return Receivable.create({
    receivableNo: await counters.receivableNo(), dealId: deal._id, listerId: lister.user._id, propertyId: p._id, agentId: agent.user._id, teamId: team._id, dealNo: deal.dealNo,
    commissionAmount: 100000, gstAmount: 18000, totalDue: 118000, status: 'invoiced',
    invoices: [{ invoiceNo: `INV-P7-${Date.now()}-${Math.random()}`, status: 'issued', taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, total: 118000, dueDate: new Date(Date.now() + 15 * DAY) }],
    ...over,
  });
}

describe('[I][admin] RE-I-07 write-off with an amount', () => {
  test('a partial write-off keeps the receivable open with a lower outstanding; the rest closes it', async () => {
    const F = h.bearer((await h.userWithToken('admin', { permissions: FIN })).token);
    const r = await receivable();
    const over = await request(app).post(`/api/admin/receivables/${r._id}/write-off`).set(F).send({ reason: 'Goodwill discount agreed', amount: 1180.01 });
    expect(over.status).toBe(422);
    const part = await request(app).post(`/api/admin/receivables/${r._id}/write-off`).set(F).send({ reason: 'Goodwill discount agreed', amount: 500 }).expect(200);
    expect(part.body.data).toMatchObject({ status: 'invoiced', partial: true, writtenOffAmount: 50000, outstanding: 68000, collectible: 68000 });
    // A payment of the rest now settles it.
    const pay = await request(app).post(`/api/admin/receivables/${r._id}/payments`).set(F).send({ amount: 680, mode: 'bank_transfer', reference: 'UTRP7' });
    expect(pay.status).toBe(201);
    expect(pay.body.data).toMatchObject({ status: 'paid', outstanding: 0 });

    const r2 = await receivable();
    await request(app).post(`/api/admin/receivables/${r2._id}/write-off`).set(F).send({ reason: 'Goodwill discount agreed', amount: 200 }).expect(200);
    const full = await request(app).post(`/api/admin/receivables/${r2._id}/write-off`).set(F).send({ reason: 'Lister closed the business' }).expect(200);
    expect(full.body.data).toMatchObject({ status: 'written_off', partial: false, writtenOffAmount: 118000, outstanding: 0 });
    const saved = await Receivable.findById(r2._id).lean();
    expect(saved.timeline.some((t) => t.type === 'write_off' && /partial/.test(t.note))).toBe(true);
    expect(await AuditLog.countDocuments({ entityId: r2._id, action: { $in: ['receivable.write_off', 'receivable.write_off.partial'] } })).toBe(2);
  });

  test('a disputed receivable stays disputed after a partial write-off', async () => {
    const r = await receivable({ status: 'disputed', dispute: { reason: 'Disputed amount', raisedAt: new Date(), previousStatus: 'invoiced' } });
    const res = await request(app).post(`/api/admin/receivables/${r._id}/write-off`).set(S).send({ reason: 'Settled part of the dispute', amount: 100 }).expect(200);
    expect(res.body.data).toMatchObject({ status: 'disputed', partial: true, outstanding: 108000 });
  });
});

// ---------------------------------------------------------------- 4. audit and login CSV exports

describe('[O][admin] RE-O-05/06 audit log and login history CSV', () => {
  test('audit export uses the list filters, names the actor and is capped at 10,000 rows', async () => {
    const res = await request(app).get('/api/admin/audit-logs/export').query({ action: 'listing_report.' }).set(S).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/audit-logs-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.headers['x-export-truncated']).toBe('false');
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('at,actor,actorEmail,actorRole,action,entityType,entityId,reason,ip');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(1).every((l) => l.includes('listing_report.'))).toBe(true);
    expect(res.text).toContain('Root Admin');

    const docs = Array.from({ length: 10001 }, (_, i) => ({ action: 'bulk.p7', actorRole: 'system', reason: `=cmd ${i}`, at: new Date(Date.now() - i * 1000) }));
    await AuditLog.insertMany(docs, { lean: true });
    const big = await request(app).get('/api/admin/audit-logs/export').query({ action: 'bulk.p7' }).set(S).expect(200);
    expect(big.headers['x-export-truncated']).toBe('true');
    expect(big.text.split('\n')).toHaveLength(10001); // header + 10,000
    expect(big.text).toContain("'=cmd 0"); // formula injection neutralised
    expect(await AuditLog.countDocuments({ action: 'audit_logs.export' })).toBe(2);
  }, 60000);

  test('login history export filters by user and result; logs.view is required', async () => {
    await LoginHistory.create([
      { userId: agent.user._id, success: true, method: 'password', ip: '10.0.0.1', ua: 'jest' },
      { userId: agent.user._id, success: false, method: 'password', reason: 'bad_password', ip: '10.0.0.2', ua: 'jest' },
      { userId: otherAgent.user._id, success: true, method: 'otp', ip: '10.0.0.3', ua: 'jest' },
    ]);
    const res = await request(app).get('/api/admin/login-history/export').query({ userId: String(agent.user._id), success: 'false' }).set(S).expect(200);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('at,user,email,role,success,method,reason,ip,userAgent');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('bad_password');
    expect(lines[1]).toContain(agent.user.email);
    expect((await request(app).get('/api/admin/login-history/export').query({ userId: 'nope' }).set(S)).status).toBe(422);
    const noPerm = h.bearer((await h.userWithToken('admin', { permissions: ['dashboard.view'] })).token);
    expect((await request(app).get('/api/admin/audit-logs/export').set(noPerm)).status).toBe(403);
    expect((await request(app).get('/api/admin/login-history/export').set(noPerm)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- 5. integration status cards

describe('[N][admin] RE-S-ADM-30 integration status', () => {
  test('one card per channel with provider, switch and the last success / failure; no secrets', async () => {
    const old = new Date(Date.now() - 3600000);
    await Job.create([
      { type: 'notify.email', status: 'done', finishedAt: old, payload: {} },
      { type: 'notify.email', status: 'queued', lastError: 'SMTP 550 mailbox unavailable', payload: {} },
      { type: 'notify.sms', status: 'done', finishedAt: new Date(), payload: {} },
      { type: 'notify.sms', status: 'dead', lastError: 'DLT template rejected', finishedAt: old, payload: {} },
    ]);
    await Outbox.create({ eventId: `p7-${Date.now()}`, type: 'deal.closed', payload: { data: {} }, status: 'sent', sentAt: new Date() });
    const res = await request(app).get('/api/admin/integrations/status').set(S).expect(200);
    const by = Object.fromEntries(res.body.data.channels.map((c) => [c.key, c]));
    expect(Object.keys(by).sort()).toEqual(['email', 'geocoder', 'mlm', 'sms', 'storage', 'telephony', 'whatsapp']);
    expect(by.email).toMatchObject({ provider: 'test', enabled: true, lastError: 'SMTP 550 mailbox unavailable', status: 'error' });
    expect(new Date(by.email.lastFailureAt) > new Date(by.email.lastSuccessAt)).toBe(true);
    expect(by.sms).toMatchObject({ provider: env.SMS_PROVIDER, dead: 1 });
    expect(by.geocoder).toMatchObject({ provider: 'none', enabled: false, status: 'off', tracked: { success: false, failure: false } });
    expect(by.whatsapp).toMatchObject({ settingKey: 'whatsapp.enabled', enabled: false, status: 'off' });
    expect(by.mlm.lastSuccessAt).toBeTruthy();
    expect(by.storage.lastSuccessAt).toBeTruthy(); // files were stored earlier in this suite
    const text = JSON.stringify(res.body.data);
    for (const secret of [env.JWT_ACCESS_SECRET, env.ENCRYPTION_KEY, env.SMTP_PASS, env.MLM_PLATFORM_SECRET, env.WHATSAPP_ACCESS_TOKEN, env.CLOUDINARY_API_SECRET].filter(Boolean)) expect(text).not.toContain(secret);
    expect((await request(app).get('/api/admin/integrations/status').set(h.bearer(manager.token))).status).toBe(403);
  });
});

// ---------------------------------------------------------------- 6. dashboard tiles

describe('[O][admin] RE-S-ADM-01 dashboard tiles', () => {
  test('paused listings, offers awaiting the owner, commission this month / FY, overdue invoices and deals past the SLA', async () => {
    const base = (await request(app).get('/api/admin/dashboard').set(S).expect(200)).body.data;
    const p = await liveListing(w, lister, { status: 'paused' });
    const lead = await leadOn(p);
    await Offer.create({ offerNo: await counters.offerNo(), leadId: lead._id, propertyId: p._id, listerId: lister.user._id, agentId: agent.user._id, status: 'awaiting_lister', rounds: [{ n: 1, by: 'agent', kind: 'offer', amount: 8000000 }] });
    await Deal.create({ dealNo: await counters.dealNo(), leadId: lead._id, propertyId: p._id, agentId: agent.user._id, teamId: team._id, listerId: lister.user._id, dealType: 'sale', status: 'verified', commissionAmount: 5000000, gstAmount: 900000, submittedAt: new Date(), review: { verifiedAt: new Date() } });
    await Deal.create({ dealNo: await counters.dealNo(), leadId: lead._id, propertyId: p._id, agentId: agent.user._id, teamId: team._id, listerId: lister.user._id, dealType: 'sale', status: 'submitted', submittedAt: new Date(Date.now() - 100 * 3600000) });
    await receivable({ status: 'overdue', invoices: [{ invoiceNo: `INV-P7-OD-${Date.now()}`, status: 'issued', taxable: 100000, total: 118000, dueDate: new Date(Date.now() - 5 * DAY) }] });

    const d = (await request(app).get('/api/admin/dashboard').set(S).expect(200)).body.data;
    expect(d.listings.paused).toBe(base.listings.paused + 1);
    expect(d.offers.awaitingOwner).toBe(base.offers.awaitingOwner + 1);
    expect(d.deals.beyondSla).toBe(base.deals.beyondSla + 1);
    expect(d.deals.slaHours).toBe(72);
    expect(d.commission.month.commission).toBe(base.commission.month.commission + 5000000 + 100000); // + the receivable's own verified deal
    expect(d.commission.month.deals).toBe(base.commission.month.deals + 2);
    expect(d.commission.financialYear.commission).toBeGreaterThanOrEqual(d.commission.month.commission);
    expect(new Date(d.commission.financialYear.from).getUTCMonth()).toBe(2); // 1 April 00:00 IST = 31 March 18:30 UTC
    expect(d.receivables.invoicesOverdue.count).toBe(base.receivables.invoicesOverdue.count + 1);
    expect(d.receivables.invoicesOverdue.amount).toBe(base.receivables.invoicesOverdue.amount + 118000);

    // Managers: team scope; offers via the team's agents; no paused-listings tile.
    const m = (await request(app).get('/api/admin/dashboard').set(h.bearer(manager.token)).expect(200)).body.data;
    expect(m.scope).toBe('team');
    expect(m.listings).toBeNull();
    expect(m.offers.awaitingOwner).toBeGreaterThanOrEqual(1);
    expect(m.deals.beyondSla).toBeGreaterThanOrEqual(1);
    expect(m.commission.month.commission).toBeGreaterThanOrEqual(5000000);
    const otherMgr = await h.userWithToken('manager', { permissions: ['dashboard.view'] });
    await Team.create({ name: 'Empty team', managerIds: [otherMgr.user._id], members: [{ agentId: otherAgent.user._id }] });
    const e = (await request(app).get('/api/admin/dashboard').set(h.bearer(otherMgr.token)).expect(200)).body.data;
    expect(e).toMatchObject({ offers: { awaitingOwner: 0 }, deals: { beyondSla: 0 } });
    expect(e.commission.month.commission).toBe(0);
  });
});

// ---------------------------------------------------------------- 7. partners

describe('[H][admin] RE-H-10 partner agreements and loan amounts', () => {
  test('agreementFileId (signed_agreement upload) on create / edit, a signed link, removal with null', async () => {
    const F = await h.userWithToken('admin', { permissions: FIN });
    const fileId = await upload(F.token, 'signed_agreement', 'partner');
    const c = await request(app).post('/api/admin/partners').set(h.bearer(F.token)).send({ name: 'Axis Home Loans', type: 'bank', contact: { email: 'loans@axis.example.com' }, agreementFileId: fileId }).expect(201);
    expect(String(c.body.data.agreementFileId)).toBe(fileId);
    expect((await storage.FileModel.findById(fileId)).attachedTo.type).toBe('Partner');
    const link = await request(app).get(`/api/admin/partners/${c.body.data._id}/agreement`).set(h.bearer(F.token)).expect(200);
    expect(link.body.data.url).toMatch(/^http/);
    expect(link.body.data.mime).toBe('application/pdf');

    const receipt = await upload(agent.token, 'receipt', 'wrong');
    const bad = await request(app).patch(`/api/admin/partners/${c.body.data._id}`).set(h.bearer(F.token)).send({ agreementFileId: receipt });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('agreementFileId');

    const second = await upload(F.token, 'signed_agreement', 'partner-v2');
    const e = await request(app).patch(`/api/admin/partners/${c.body.data._id}`).set(h.bearer(F.token)).send({ agreementFileId: second }).expect(200);
    expect(String(e.body.data.agreementFileId)).toBe(second);
    // A file attached to one partner cannot be reused for another.
    const other = await request(app).post('/api/admin/partners').set(h.bearer(F.token)).send({ name: 'Other Bank', type: 'bank', contact: { email: 'o@bank.example.com' }, agreementFileId: second });
    expect(other.status).toBe(422);
    await request(app).patch(`/api/admin/partners/${c.body.data._id}`).set(h.bearer(F.token)).send({ agreementFileId: null }).expect(200);
    const gone = await request(app).get(`/api/admin/partners/${c.body.data._id}/agreement`).set(h.bearer(F.token));
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('NO_AGREEMENT');
    expect((await request(app).get(`/api/admin/partners/${c.body.data._id}/agreement`).set(h.bearer(manager.token))).status).toBe(403);
  });

  test('loan referrals take sanctioned and disbursed amounts in rupees (stored as paise)', async () => {
    const loan = await PartnerReferral.create({ refNo: await counters.partnerReferralNo(), kind: 'loan', status: 'sanctioned', amount: 500000000 });
    const ok = await request(app).patch(`/api/admin/partner-referrals/${loan._id}`).set(S).send({ sanctionedAmount: 4500000, disbursedAmount: 4000000 }).expect(200);
    expect(ok.body.data).toMatchObject({ sanctionedAmount: 450000000, disbursedAmount: 400000000 });
    const tooMuch = await request(app).patch(`/api/admin/partner-referrals/${loan._id}`).set(S).send({ disbursedAmount: 5000000 });
    expect(tooMuch.status).toBe(422);
    expect((await PartnerReferral.findById(loan._id)).disbursedAmount).toBe(400000000);
    await request(app).patch(`/api/admin/partner-referrals/${loan._id}`).set(S).send({ disbursedAmount: null }).expect(200);
    expect((await PartnerReferral.findById(loan._id)).disbursedAmount).toBeUndefined();
    const service = await PartnerReferral.create({ refNo: await counters.partnerReferralNo(), kind: 'rental_agreement', status: 'requested' });
    expect((await request(app).patch(`/api/admin/partner-referrals/${service._id}`).set(S).send({ sanctionedAmount: 1000 })).status).toBe(422);
  });
});

// ---------------------------------------------------------------- 8. commission preview

describe('[H][agent] RE-H-09 commission preview', () => {
  test('the preview equals the commission saved on the deal (same function); GST split; nothing is saved', async () => {
    const p = await liveListing(w, lister, { amount: 8000000 });
    await Agreement.create({ agreementNo: await counters.agreementNo(), propertyId: p._id, listerId: lister.user._id, version: 1, commissionPercent: 1.5, basis: 'sale_price', textSnapshot: 'Agreement', textHash: 'hash', status: 'accepted', effectiveFrom: new Date(Date.now() - 30 * DAY) });
    const lead = await leadOn(p);
    const deals = await Deal.countDocuments();
    const pv = await request(app).post('/api/agent/deals/preview-commission').set(G).send({ leadId: String(lead._id), agreedPrice: 8000000, bookingDate: new Date().toISOString() }).expect(200);
    expect(pv.body.data).toMatchObject({ available: true, percent: 1.5, basis: 'sale_price', basisAmount: 800000000, commission: 12000000, gstAmount: 2160000, total: 14160000 });
    expect(pv.body.data.gst).toMatchObject({ interState: false, cgst: 1080000, sgst: 1080000, igst: 0 });
    expect(await Deal.countDocuments()).toBe(deals);

    const draft = await request(app).post('/api/agent/deals').set(G).send({ leadId: String(lead._id), agreedPrice: 8000000, bookingAmount: 200000, bookingDate: new Date().toISOString(), paymentMode: 'bank_transfer', paymentReference: `UTRP7${Date.now()}` }).expect(201);
    expect(draft.body.data.commissionAmount).toBe(pv.body.data.commission);
    expect(draft.body.data.gstAmount).toBe(pv.body.data.gstAmount);

    // propertyId alone also works; the listing's fallback percent applies when no agreement exists.
    const rent = await liveListing(w, lister, { purpose: 'rent', amount: 30000 });
    const r = await request(app).post('/api/agent/deals/preview-commission').set(G).send({ propertyId: String(rent._id), monthlyRent: 30000 }).expect(200);
    expect(r.body.data).toMatchObject({ dealType: 'rent', basis: 'annual_rent', basisAmount: 36000000, percent: 2, commission: 720000 });
    expect((await request(app).post('/api/agent/deals/preview-commission').set(G).send({ propertyId: String(rent._id), dealType: 'sale', agreedPrice: 1 })).status).toBe(422);
  });

  test('another agent cannot preview on a lead that is not theirs', async () => {
    const p = await liveListing(w, lister);
    const lead = await leadOn(p);
    expect((await request(app).post('/api/agent/deals/preview-commission').set(h.bearer(otherAgent.token)).send({ leadId: String(lead._id), agreedPrice: 100 })).status).toBe(403);
    expect((await request(app).post('/api/agent/deals/preview-commission').set(G).send({ agreedPrice: 100 })).status).toBe(422);
  });
});

// ---------------------------------------------------------------- 9. lister range stats

describe('[O][lister] RE-O-08 range counters next to lifetime totals', () => {
  test('rangeCounters count only records dated inside from..to', async () => {
    const p = await liveListing(w, lister);
    await Property.updateOne({ _id: p._id }, { $set: { 'stats.enquiries': 9, 'stats.shortlists': 5 } });
    const old = new Date(Date.now() - 60 * DAY);
    await leadOn(p);
    const oldLead = await leadOn(p);
    await Lead.collection.updateOne({ _id: oldLead._id }, { $set: { createdAt: old } });
    await SiteVisit.create({ visitNo: await counters.visitNo(), leadId: oldLead._id, propertyId: p._id, agentId: agent.user._id, scheduledAt: new Date(Date.now() - DAY), status: 'completed' });
    await SiteVisit.create({ visitNo: await counters.visitNo(), leadId: oldLead._id, propertyId: p._id, agentId: agent.user._id, scheduledAt: old, status: 'completed' });
    const buyer = await h.userWithToken('buyer');
    const buyer2 = await h.userWithToken('buyer');
    await Shortlist.create({ userId: buyer.user._id, propertyId: p._id });
    const s2 = await Shortlist.create({ userId: buyer2.user._id, propertyId: p._id });
    await Shortlist.collection.updateOne({ _id: s2._id }, { $set: { createdAt: old } });

    const from = new Date(Date.now() - 7 * DAY).toISOString();
    const st = await request(app).get(`/api/lister/properties/${p._id}/stats`).query({ from, to: new Date().toISOString() }).set(lister.t).expect(200);
    expect(st.body.data.rangeCounters).toMatchObject({ enquiries: 1, visitsDone: 1, shortlists: 1, offersReceived: 0 });
    expect(st.body.data.counters).toMatchObject({ enquiries: 9, shortlists: 5, visitsDone: 2 });
  });
});
