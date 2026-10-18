// Phase 6 (spec M6) - Module O reports, dashboards, exports and retention;
// RE-D-13 site verification visits; RE-K-08 WhatsApp inbound webhook;
// RE-F-10 manual seeker flag.
const crypto = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx2 = require('../phase2/fixtures');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead, SiteVisit, BuyerContact } = require('../../src/modules/leads/models');
const { Deal } = require('../../src/modules/deals/models');
const { Team } = require('../../src/modules/teams/models');
const { ExportJob } = require('../../src/modules/reports/models');
const { SeekerFlag } = require('../../src/modules/kyc/models');
const { VerificationVisit } = require('../../src/modules/approvals/models');
const counters = require('../../src/core/counters');
const settings = require('../../src/core/settings');
const env = require('../../src/config/env');
const reports = require('../../src/modules/reports/service');

let app; let w; let lister; let A; let agentA; let agentB; let manager; let teamA; let teamB;
const DAY = 86400000;

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  A = h.bearer((await h.userWithToken('superadmin')).token);
  agentA = await h.userWithToken('agent', { permissions: ['verification.field'] });
  agentB = await h.userWithToken('agent');
  manager = await h.userWithToken('manager', { permissions: ['reports.view', 'dashboard.view'] });
  teamA = await Team.create({ name: 'Reports A', managerIds: [manager.user._id], members: [{ agentId: agentA.user._id }] });
  teamB = await Team.create({ name: 'Reports B', members: [{ agentId: agentB.user._id }] });
});
afterAll(() => mongoose.disconnect());

let n = 0;
async function lead(p, agent, team, over = {}) {
  n += 1;
  return Lead.create({
    leadNo: await counters.leadNo(), buyer: { name: `Buyer ${n}`, phone: `+9197700${String(10000 + n).slice(-5)}`, email: `b${n}@example.com` }, propertyId: p._id,
    stage: 'contacted', assignedTo: agent.user._id, teamId: team._id, assignedAt: new Date(), slaDueAt: new Date(Date.now() + 3600000), firstContactAt: new Date(), sources: ['enquiry'], requirement: { city: 'Pune' }, ...over,
  });
}

describe('[O][admin] RE-O-02/03 Reports', () => {
  let p;
  beforeAll(async () => {
    p = await liveListing(w, lister);
    const leads = [];
    for (let i = 0; i < 4; i += 1) leads.push(await lead(p, agentA, teamA));
    await lead(p, agentB, teamB);
    await Deal.create({ dealNo: await counters.dealNo(), leadId: leads[0]._id, propertyId: p._id, agentId: agentA.user._id, teamId: teamA._id, listerId: lister.user._id, dealType: 'sale', status: 'verified', commissionAmount: 12000000, gstAmount: 2160000, submittedAt: new Date(), review: { verifiedAt: new Date() } });
  });

  test('acceptance 2: agent conversion % = verified deals / leads assigned in the period', async () => {
    const r = await request(app).get('/api/admin/reports/agents').set(A).expect(200);
    const row = r.body.data.rows.find((x) => x.agentId === String(agentA.user._id));
    expect(row).toMatchObject({ leadsAssigned: 4, dealsVerified: 1, conversionPercent: 25, commission: 12000000, slaMetPercent: 100 });
    const own = await request(app).get('/api/agent/performance').set(h.bearer(agentA.token)).expect(200);
    expect(own.body.data).toMatchObject({ leadsAssigned: 4, dealsVerified: 1, conversionPercent: 25 });
  });

  test('acceptance 3: a manager gets only team-scoped data', async () => {
    const M = h.bearer(manager.token);
    const leads = await request(app).get('/api/admin/reports/leads').set(M).expect(200);
    expect(leads.body.data.summary.total).toBe(4);
    const agents = await request(app).get('/api/admin/reports/agents').set(M).expect(200);
    expect(agents.body.data.rows.map((x) => x.agentId)).toEqual([String(agentA.user._id)]);
    const dash = await request(app).get('/api/admin/dashboard').set(M).expect(200);
    expect(dash.body.data).toMatchObject({ scope: 'team', queues: null });
    const all = await request(app).get('/api/admin/reports/leads').set(A).expect(200);
    expect(all.body.data.summary.total).toBe(5);
  });

  test('RE-J-07: the listings report for a manager covers only the territories of their teams', async () => {
    const M = h.bearer(manager.token);
    const total = (r) => r.body.data.byStatus.reduce((a, x) => a + x.count, 0);
    const admin = await request(app).get('/api/admin/reports/listings').set(A).expect(200);
    expect(admin.body.data.scope).toBe('all');
    expect(total(admin)).toBeGreaterThan(0);
    // team A has no territory yet: nothing is in scope
    const none = await request(app).get('/api/admin/reports/listings').set(M).expect(200);
    expect(none.body.data.scope).toBe('team_territories');
    expect(total(none)).toBe(0);
    // a territory elsewhere still shows nothing; the listing's own city shows it
    await Team.updateOne({ _id: teamA._id }, { $set: { 'territories.cities': ['Nowhere City'] } });
    expect(total(await request(app).get('/api/admin/reports/listings').set(M).expect(200))).toBe(0);
    await Team.updateOne({ _id: teamA._id }, { $set: { 'territories.cities': [String(p.location.city).toUpperCase()] } });
    const mine = await request(app).get('/api/admin/reports/listings').set(M).expect(200);
    expect(total(mine)).toBeGreaterThan(0);
    expect(mine.body.data.byCity.every((x) => x.city.toLowerCase() === String(p.location.city).toLowerCase())).toBe(true);
    await Team.updateOne({ _id: teamA._id }, { $unset: { territories: 1 } });
  });

  test('funnel, SLA, commission, listings and ageing reports; unknown key is 404', async () => {
    const funnel = await request(app).get('/api/admin/reports/funnel').set(A).expect(200);
    expect(funnel.body.data.rows[0]).toMatchObject({ stage: 'new', leads: 5 });
    expect(funnel.body.data.rows.find((x) => x.stage === 'contacted').leads).toBe(5);
    const sla = await request(app).get('/api/admin/reports/sla').set(A).expect(200);
    expect(sla.body.data.summary.slaMetPercent).toBe(100);
    const com = await request(app).get('/api/admin/reports/commission').set(A).expect(200);
    expect(com.body.data.summary.commission).toBe(12000000);
    expect(com.body.data.ageing.buckets).toHaveProperty('90+');
    await request(app).get('/api/admin/reports/listings').set(A).expect(200);
    await request(app).get('/api/admin/reports/ageing').set(A).expect(200);
    expect((await request(app).get('/api/admin/reports/nope').set(A)).status).toBe(404);
    expect((await request(app).get('/api/admin/reports/leads').set(h.bearer(agentA.token))).status).toBe(403);
  });

  test('RE-O-07 CSV export streams small reports; async exports run as a job with a 24 h link', async () => {
    const csv = await request(app).get('/api/admin/reports/agents/export').set(A).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toMatch(/^agent,leadsAssigned/);
    expect(csv.text).toContain('120000'); // commission in rupees
    const q = await request(app).get('/api/admin/reports/leads/export').query({ async: 'true' }).set(A).expect(202);
    const id = q.body.data.exportId;
    await reports.runExport({ exportId: id });
    const dl = await request(app).get(`/api/admin/exports/${id}`).set(A).expect(200);
    expect(dl.body.data).toMatchObject({ status: 'ready' });
    expect(dl.body.data.url).toMatch(/^http/);
    expect((await request(app).get(`/api/admin/exports/${id}`).set(h.bearer(manager.token))).status).toBe(403); // admin-only route
    await ExportJob.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`/api/admin/exports/${id}`).set(A)).body.error.code).toBe('EXPORT_EXPIRED');
  });

  test('admin dashboard has queues and integration health', async () => {
    const d = await request(app).get('/api/admin/dashboard').set(A).expect(200);
    expect(d.body.data).toMatchObject({ scope: 'all' });
    expect(d.body.data.queues).toHaveProperty('listings');
    expect(d.body.data.integrations).toHaveProperty('outboxDead');
  });
});

describe('[O][lister] RE-O-08 Lister stats', () => {
  test('dashboard aggregates and per-listing stats; other listers get 404', async () => {
    const p = await liveListing(w, lister);
    await request(app).post(`/api/properties/${p._id}/view`).set('User-Agent', 'Mozilla/5.0').set('X-Session-Id', 's1');
    const dash = await request(app).get('/api/lister/dashboard').set(lister.t).expect(200);
    expect(dash.body.data.listings.total).toBeGreaterThan(0);
    const st = await request(app).get(`/api/lister/properties/${p._id}/stats`).set(lister.t).expect(200);
    expect(st.body.data).toHaveProperty('viewsPerDay');
    expect(st.body.data.funnel[0].stage).toBe('new');
    expect(JSON.stringify(st.body.data)).not.toMatch(/Buyer \d|@example\.com|\+9197700/);
    const other = await fx2.verifiedLister('owner');
    expect((await request(app).get(`/api/lister/properties/${p._id}/stats`).set(other.t)).status).toBe(404);
  });
});

describe('[O][system] RE-O-09 Lead-data retention', () => {
  test('acceptance 4: a closed_lost lead without a deal is anonymised after 24 months; a lead with a deal keeps buyer data', async () => {
    const p = await liveListing(w, lister);
    const old = new Date(Date.now() - 25 * 30 * DAY);
    const contact = await BuyerContact.create({ phone: '+919811100001', name: 'Old Buyer', email: 'old@example.com' });
    const lost = await lead(p, agentA, teamA, { stage: 'closed_lost', closedAt: old, lostReason: 'budget', lostNote: 'Call me on 98111 00001', buyer: { contactId: contact._id, name: 'Old Buyer', phone: '+919811100001', email: 'old@example.com' } });
    const kept = await lead(p, agentA, teamA, { stage: 'closed_lost', closedAt: old, lostReason: 'budget' });
    await Deal.create({ dealNo: await counters.dealNo(), leadId: kept._id, propertyId: p._id, agentId: agentA.user._id, listerId: lister.user._id, dealType: 'sale', status: 'reversed' });
    const recent = await lead(p, agentA, teamA, { stage: 'closed_lost', closedAt: new Date(), lostReason: 'budget' });
    const dry = await reports.runRetention({ dryRun: true });
    expect(dry.list).toContain(lost.leadNo);
    expect((await Lead.findById(lost._id)).buyer.name).toBe('Old Buyer'); // dry run changes nothing
    const r = await reports.runRetention();
    expect(r.leads).toBe(1);
    const a = await Lead.findById(lost._id);
    expect(a.buyer).toMatchObject({ name: 'Buyer anonymised', phone: null, email: null });
    expect(a.lostNote).toBeNull();
    expect(a.anonymisedAt).toBeTruthy();
    expect((await BuyerContact.findById(contact._id)).name).toBe('Buyer anonymised');
    expect((await Lead.findById(kept._id)).buyer.phone).toBeTruthy();
    expect((await Lead.findById(recent._id)).buyer.phone).toBeTruthy();
  });
});

describe('[D][admin] RE-D-13 Site verification visits (Could)', () => {
  const tomorrow11 = () => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2));
    return new Date(d.getTime() + (11 * 60 - 330) * 60000);
  };
  test('lister request -> schedule -> outcome only after start -> verified badge; the agent sees only own visits', async () => {
    const p = await liveListing(w, lister);
    expect((await request(app).post(`/api/lister/properties/${p._id}/verification/site-request`).set(lister.t).send({})).body.error.code).toBe('FEATURE_DISABLED');
    await settings.set('verification.siteVisitEnabled', true);
    const req1 = await request(app).post(`/api/lister/properties/${p._id}/verification/site-request`).set(lister.t).send({ note: 'Weekends best' }).expect(201);
    expect((await request(app).post(`/api/lister/properties/${p._id}/verification/site-request`).set(lister.t).send({})).body.error.code).toBe('VISIT_OPEN');
    expect((await request(app).post('/api/admin/verification/visits').set(A).send({ visitId: req1.body.data._id, scheduledAt: tomorrow11(), executiveId: String(agentB.user._id) })).status).toBe(422); // no field permission
    const s = await request(app).post('/api/admin/verification/visits').set(A).send({ visitId: req1.body.data._id, scheduledAt: tomorrow11(), executiveId: String(agentA.user._id) }).expect(201);
    expect(s.body.data.status).toBe('scheduled');
    const G = h.bearer(agentA.token);
    const mine = await request(app).get('/api/agent/verification-visits').set(G).expect(200);
    expect(mine.body.data).toHaveLength(1);
    const photos = [];
    for (let i = 0; i < 4; i += 1) {
      photos.push((await request(app).post('/api/uploads?purpose=verification_photo').set(G).attach('file', await fx2.photo(), { filename: `s${i}.jpg`, contentType: 'image/jpeg' }).expect(201)).body.data.id);
    }
    const gps = { lat: p.location.geo.coordinates[1], lng: p.location.geo.coordinates[0], accuracy: 15 };
    const all = Object.fromEntries(['existsAtPin', 'matchesPhotos', 'matchesDetails', 'ownerPresentWithId', 'noBrokerBoard'].map((k) => [k, true]));
    const early = await request(app).post(`/api/agent/verification-visits/${s.body.data._id}/outcome`).set(G).send({ result: 'verified', checklist: all, photoFileIds: photos, gps });
    expect(early.body.error.code).toBe('VISIT_NOT_STARTED');
    await VerificationVisit.updateOne({ _id: s.body.data._id }, { $set: { scheduledAt: new Date(Date.now() - 60000) } });
    expect((await request(app).post(`/api/agent/verification-visits/${s.body.data._id}/outcome`).set(G).send({ result: 'verified', checklist: { ...all, noBrokerBoard: false }, photoFileIds: photos, gps })).status).toBe(422);
    const ok = await request(app).post(`/api/agent/verification-visits/${s.body.data._id}/outcome`).set(G).send({ result: 'verified', checklist: all, photoFileIds: photos, gps }).expect(200);
    expect(ok.body.data.distanceM).toBeLessThan(5);
    const pub = await request(app).get(`/api/properties/${p.slug}`).expect(200);
    expect(pub.body.data.badges.map((b) => b.code)).toContain('site_verified');
  });

  test('lister absent: one reschedule allowed', async () => {
    const p = await liveListing(w, lister);
    const s = await request(app).post('/api/admin/verification/visits').set(A).send({ propertyId: String(p._id), scheduledAt: tomorrow11(), executiveId: String(agentA.user._id) }).expect(201);
    await VerificationVisit.updateOne({ _id: s.body.data._id }, { $set: { scheduledAt: new Date(Date.now() - 60000) } });
    await request(app).post(`/api/agent/verification-visits/${s.body.data._id}/outcome`).set(h.bearer(agentA.token)).send({ result: 'lister_absent', remarks: 'Locked' }).expect(200);
    await request(app).patch(`/api/admin/verification/visits/${s.body.data._id}`).set(A).send({ scheduledAt: tomorrow11() }).expect(200);
    await VerificationVisit.updateOne({ _id: s.body.data._id }, { $set: { scheduledAt: new Date(Date.now() - 60000) } });
    await request(app).post(`/api/agent/verification-visits/${s.body.data._id}/outcome`).set(h.bearer(agentA.token)).send({ result: 'lister_absent' }).expect(200);
    expect((await request(app).patch(`/api/admin/verification/visits/${s.body.data._id}`).set(A).send({ scheduledAt: tomorrow11() })).body.error.code).toBe('RESCHEDULE_LIMIT');
    const list = await request(app).get('/api/admin/verification/visits').set(A).query({ status: 'lister_absent' }).expect(200);
    expect(list.body.data.some((x) => x._id === s.body.data._id)).toBe(true);
  });
});

describe('[B][integrations] RE-K-08 WhatsApp inbound webhook', () => {
  const body = (from, text, id) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Wa Buyer' } }], messages: [{ id, from, type: 'text', text: { body: text } }] } }] }] });
  const send = (payload, secret) => {
    const raw = JSON.stringify(payload);
    const r = request(app).post('/api/webhooks/whatsapp').set('Content-Type', 'application/json');
    if (secret) r.set('X-Hub-Signature-256', `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
    return r.send(raw);
  };

  test('disabled -> 503; bad signature -> 401; a message quoting a listing number creates one whatsapp lead (retries de-duplicated)', async () => {
    const p = await liveListing(w, lister);
    expect((await send(body('919812300001', `Hi ${p.listingNo}`, 'wamid.1'))).status).toBe(503);
    await settings.set('whatsapp.enabled', true);
    await settings.set('lead.maxEnquiriesPerIpPerHour', 1000);
    const prev = env.WHATSAPP_APP_SECRET;
    env.WHATSAPP_APP_SECRET = 'wa-test-secret';
    try {
      expect((await send(body('919812300001', `Hi ${p.listingNo}`, 'wamid.2'), 'wrong')).status).toBe(401);
      const ok = await send(body('919812300001', `Hi, is ${p.listingNo} available?`, 'wamid.3'), 'wa-test-secret').expect(200);
      expect(ok.body.data.messages[0]).toMatchObject({ result: 'lead' });
      const again = await send(body('919812300001', `Hi, is ${p.listingNo} available?`, 'wamid.3'), 'wa-test-secret').expect(200);
      expect(again.body.data.messages).toHaveLength(0);
      const leads = await Lead.find({ 'buyer.phone': '+919812300001' });
      expect(leads).toHaveLength(1);
      expect(leads[0].sources).toEqual(['whatsapp']);
      const none = await send(body('919812300002', 'hello there', 'wamid.4'), 'wa-test-secret').expect(200);
      expect(none.body.data.messages[0].result).toBe('no_listing');
    } finally {
      env.WHATSAPP_APP_SECRET = prev;
    }
  });
});

describe('[F][agent] RE-F-10 Manual seeker flag', () => {
  test('an agent flags a phone from the lead; a second flag adds to the same open flag', async () => {
    const p = await liveListing(w, lister);
    const l = await lead(p, agentA, teamA);
    const G = h.bearer(agentA.token);
    expect((await request(app).post(`/api/agent/leads/${l._id}/seeker-flag`).set(G).send({ note: 'short' })).status).toBe(422);
    const r = await request(app).post(`/api/agent/leads/${l._id}/seeker-flag`).set(G).send({ note: 'Asks for owner numbers on every call' }).expect(201);
    expect(r.body.data.rule).toBe('manual');
    await request(app).post(`/api/agent/leads/${l._id}/seeker-flag`).set(G).send({ note: 'Admitted to being a broker' }).expect(201);
    const flags = await SeekerFlag.find({ flagNo: r.body.data.flagNo });
    expect(flags).toHaveLength(1);
    expect(flags[0].note).toMatch(/broker/);
    const otherAgent = await h.userWithToken('agent');
    expect((await request(app).post(`/api/agent/leads/${l._id}/seeker-flag`).set(h.bearer(otherAgent.token)).send({ note: 'not my lead at all' })).status).toBe(403);
  });
});

describe('[M][admin] RE-S-ADM-24/25/29 Buyer accounts, data rights and settings', () => {
  test('settings list shows editability; PATCH validates type and permission and is audited', async () => {
    const list = await request(app).get('/api/admin/settings').set(A).expect(200);
    const due = list.body.data.find((s) => s.key === 'invoice.dueDays');
    expect(due).toMatchObject({ type: 'number', editable: true });
    expect((await request(app).patch('/api/admin/settings').set(A).send({ changes: [{ key: 'invoice.dueDays', value: 'thirty' }] })).status).toBe(422);
    expect((await request(app).patch('/api/admin/settings').set(A).send({ changes: [{ key: 'no.such.key', value: 1 }] })).status).toBe(422);
    await request(app).patch('/api/admin/settings').set(A).send({ changes: [{ key: 'invoice.dueDays', value: 45 }] }).expect(200);
    expect(await settings.get('invoice.dueDays')).toBe(45);
    const ops = await h.userWithToken('admin', { permissions: ['integrations.manage'] });
    expect((await request(app).patch('/api/admin/settings').set(h.bearer(ops.token)).send({ changes: [{ key: 'invoice.dueDays', value: 10 }] })).body.error.code).toBe('MISSING_PERMISSION');
    await request(app).patch('/api/admin/settings').set(h.bearer(ops.token)).send({ changes: [{ key: 'mlm.enabled', value: false }] }).expect(200);
  });

  test('buyer list, block, deletion request completed -> anonymised', async () => {
    const b = await h.userWithToken('buyer', { name: 'Priya Buyer' });
    const list = await request(app).get('/api/admin/users').query({ q: 'Priya' }).set(A).expect(200);
    expect(list.body.data.map((x) => x._id)).toContain(String(b.user._id));
    await request(app).patch(`/api/admin/users/${b.user._id}/status`).set(A).send({ status: 'blocked', reason: 'Spam enquiries' }).expect(200);
    await request(app).patch(`/api/admin/users/${b.user._id}/status`).set(A).send({ status: 'active', reason: 'Cleared after a call' }).expect(200);
    const { DeletionRequest, User } = require('../../src/modules/auth/models');
    const r = await DeletionRequest.create({ userId: b.user._id, reason: 'Leaving' });
    await request(app).patch(`/api/admin/deletion-requests/${r._id}`).set(A).send({ status: 'completed', note: 'Identity confirmed by email' }).expect(200);
    const u = await User.findById(b.user._id);
    expect(u).toMatchObject({ status: 'anonymised', name: 'Anonymised user' });
    expect((await DeletionRequest.findById(r._id)).status).toBe('completed');
    expect((await request(app).post(`/api/admin/users/${b.user._id}/anonymise`).set(A).send({ reason: 'again please' })).status).toBe(409);
  });

  test('admin lead note lands on the timeline', async () => {
    const p = await liveListing(w, lister);
    const l = await lead(p, agentA, teamA);
    await request(app).post(`/api/admin/leads/${l._id}/notes`).set(A).send({ text: 'Called the buyer, wants a weekend visit' }).expect(200);
    expect((await Lead.findById(l._id)).timeline.some((t) => t.type === 'note')).toBe(true);
  });
});
