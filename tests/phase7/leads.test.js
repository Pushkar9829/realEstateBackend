// Phase 7 - Module C gaps in the agent and lister panels: reschedule reasons,
// visit outcome photos, richer lead detail (deal, team, seeker flag, next
// follow-up), WhatsApp templates (RE-K-08), list filters, lister visit and
// activity filters, blackout ids, the lister funnel and enquiry form extras.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx2 = require('../phase2/fixtures');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead, SiteVisit, ListerUpdate, VisitAvailability } = require('../../src/modules/leads/models');
const { Notification } = require('../../src/modules/notifications/models');
const settings = require('../../src/core/settings');
const notify = require('../../src/core/notify');
const { Otp } = require('../../src/modules/auth/models');

let app; let w; let lister; let A; let manager; let agents; let team;
const istAt = (daysAhead, hhmm) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead));
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(d.getTime() + (hh * 60 + mm - 330) * 60000);
};

async function guestToken(phone) {
  await h.resetOtpLimits(h.e164(phone));
  await request(app).post('/api/leads/otp').send({ phone }).expect(200);
  const code = h.otpFor(h.e164(phone));
  const r = await request(app).post('/api/leads/otp/verify').send({ phone, code }).expect(200);
  await Otp.deleteMany({ target: h.e164(phone) }); // tests send more than the 10-a-day OTP cap per phone
  return r.body.data.otpToken;
}

let phoneSeq = 0;
const newPhone = () => { phoneSeq += 1; return `97${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`; };

async function enquire(p, { type = 'enquiry', phone = newPhone(), extra = {} } = {}) {
  const otpToken = await guestToken(phone);
  return request(app).post('/api/leads/enquiry').send({ type, propertyId: String(p._id), name: 'Guest Buyer', otpToken, consent: true, ...extra });
}

async function newLead(p, opts) {
  const r = await enquire(p, opts);
  expect(r.status).toBe(201);
  const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
  const agent = agents.find((x) => String(x.user._id) === String(lead.assignedTo));
  return { lead, agent, AG: h.bearer(agent.token) };
}

async function scheduledVisit(lead, AG, p, at = istAt(2, '10:00')) {
  const r = await request(app).post('/api/agent/site-visits').set(AG).send({ leadId: String(lead._id), propertyId: String(p._id), scheduledAt: at.toISOString() });
  expect(r.status).toBe(201);
  return r.body.data;
}

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  await settings.set('lead.maxEnquiriesPerIpPerHour', 1000); // every test request comes from one IP
  await settings.set('lead.maxEnquiriesPerPhonePerDay', 50);
  const a = await h.userWithToken('superadmin');
  A = h.bearer(a.token);
  manager = await h.userWithToken('manager', { permissions: ['leads.view_all', 'leads.assign', 'sitevisits.view'] });
  agents = [await h.userWithToken('agent', { name: 'Asha Agent' }), await h.userWithToken('agent', { name: 'Bina Agent' })];
  const t = await request(app).post('/api/admin/teams').set(A).send({ name: 'Team Seven', managerIds: [String(manager.user._id)], members: agents.map((x) => ({ agentId: String(x.user._id) })), territories: { cities: ['Pune'] }, workingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } }).expect(201);
  team = t.body.data;
  await request(app).post('/api/admin/routing-rules').set(A).send({ name: 'Pune', conditions: { cities: ['Pune'] }, teamId: team._id }).expect(201);
});
afterAll(() => mongoose.disconnect());

describe('[C][public] RE-S-PUB-06 enquiry form extras', () => {
  test('callback window, visitors, pickup, budget, timeline and loan are stored as fields and shown to the agent', async () => {
    const p = await liveListing(w, lister);
    const { lead, AG } = await newLead(p, { type: 'site_visit', extra: { callbackWindow: 'evening', visitors: 3, pickupNeeded: true, budgetMax: 9000000, timeline: '1_3_months', loanNeeded: true, message: 'Weekend please' } });
    expect(lead.enquiry).toMatchObject({ callbackWindow: 'evening', visitors: 3, pickupNeeded: true });
    expect(lead.requirement).toMatchObject({ budgetMax: 9000000, timeline: '1_3_months', loanNeeded: true, notes: 'Weekend please' });
    const v = await SiteVisit.findOne({ leadId: lead._id });
    expect(v.pickup.needed).toBe(true);
    const d = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    expect(d.body.data.enquiry).toMatchObject({ callbackWindow: 'evening', visitors: 3, pickupNeeded: true });
    expect(d.body.data.requirement).toMatchObject({ budgetMax: 9000000, timeline: '1_3_months', loanNeeded: true });
  });

  test('a repeat enquiry merges the new extras; invalid extras are 422', async () => {
    const p = await liveListing(w, lister);
    const phone = newPhone();
    const r1 = await enquire(p, { phone, extra: { timeline: 'later' } });
    const r2 = await enquire(p, { phone, type: 'callback', extra: { callbackWindow: 'morning', loanNeeded: false } });
    expect(r2.body.data).toMatchObject({ merged: true, leadNo: r1.body.data.leadNo });
    const lead = await Lead.findOne({ leadNo: r1.body.data.leadNo });
    expect(lead.enquiry.callbackWindow).toBe('morning');
    expect(lead.requirement).toMatchObject({ timeline: 'later', loanNeeded: false });
    expect((await enquire(p, { extra: { visitors: 11 } })).status).toBe(422);
    expect((await enquire(p, { extra: { callbackWindow: 'midnight' } })).status).toBe(422);
  });
});

describe('[C][agent] RE-S-AGT-02 lead list filters', () => {
  test('source, city, purpose and created from / to', async () => {
    const p = await liveListing(w, lister);
    const rent = await liveListing(w, lister, { purpose: 'rent', amount: 30000 });
    const { lead: l1, agent } = await newLead(p, { type: 'best_price' });
    const AG = h.bearer(agent.token);
    // the second lead goes to the other agent by round-robin; give it to the same agent
    const { lead: l2 } = await newLead(rent);
    await Lead.updateOne({ _id: l2._id }, { $set: { assignedTo: agent.user._id } });
    const ids = async (q) => (await request(app).get('/api/agent/leads').query(q).set(AG).expect(200)).body.data.map((x) => x._id);
    expect(await ids({ source: 'best_price' })).toContain(String(l1._id));
    expect(await ids({ source: 'best_price' })).not.toContain(String(l2._id));
    expect(await ids({ purpose: 'rent' })).toEqual([String(l2._id)]);
    expect(await ids({ city: 'pune' })).toEqual(expect.arrayContaining([String(l1._id), String(l2._id)]));
    expect(await ids({ city: 'Mumbai' })).toEqual([]);
    await Lead.collection.updateOne({ _id: l1._id }, { $set: { createdAt: new Date(Date.now() - 10 * 86400000) } });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(await ids({ from: since })).not.toContain(String(l1._id));
    expect(await ids({ to: since })).toContain(String(l1._id));
    expect((await request(app).get('/api/agent/leads').query({ from: 'not-a-date' }).set(AG)).status).toBe(422);
  });
});

describe('[C][agent] RE-S-AGT-08/09 reschedule reason and outcome photos', () => {
  let p; let lead; let AG; let agent; let visit;
  beforeAll(async () => {
    p = await liveListing(w, lister);
    ({ lead, AG, agent } = await newLead(p));
    visit = await scheduledVisit(lead, AG, p);
  });

  test('moving the time needs a reason (3-300); it is kept on the visit, the timeline and the lister notification', async () => {
    const to = istAt(3, '11:00');
    expect((await request(app).patch(`/api/agent/site-visits/${visit._id}`).set(AG).send({ scheduledAt: to.toISOString() })).status).toBe(422);
    expect((await request(app).patch(`/api/agent/site-visits/${visit._id}`).set(AG).send({ scheduledAt: to.toISOString(), rescheduleReason: 'no' })).status).toBe(422);
    // editing only the meeting point needs no reason
    await request(app).patch(`/api/agent/site-visits/${visit._id}`).set(AG).send({ meetingPoint: 'At our office' }).expect(200);
    await request(app).patch(`/api/agent/site-visits/${visit._id}`).set(AG).send({ scheduledAt: to.toISOString(), rescheduleReason: 'Buyer travelling on that day' }).expect(200);
    const v = await SiteVisit.findById(visit._id);
    expect(v.history).toHaveLength(1);
    expect(v.history[0]).toMatchObject({ reason: 'Buyer travelling on that day' });
    expect(v.history[0].to.getTime()).toBe(to.getTime());
    const l = await Lead.findById(lead._id);
    expect(l.timeline.find((t) => t.type === 'visit' && t.data.status === 'rescheduled').data.reason).toBe('Buyer travelling on that day');
    const n = await Notification.findOne({ userId: lister.user._id, eventKey: 'sitevisit.lister_rescheduled' }).lean();
    expect(JSON.stringify(n)).toMatch(/Buyer travelling on that day/);
    const lv = await request(app).get('/api/lister/visits').set(lister.t).expect(200);
    expect(lv.body.data.items.find((x) => x.visitNo === v.visitNo).lastReschedule.reason).toBe('Buyer travelling on that day');
    // contact details in the reason are blocked (it reaches the lister)
    const r = await request(app).patch(`/api/agent/site-visits/${visit._id}`).set(AG).send({ scheduledAt: istAt(4, '11:00').toISOString(), rescheduleReason: 'call me on 9876543210' });
    expect(r.status).toBe(422);
  });

  test('outcome takes up to 10 own verification photos; the lead page shows signed URLs', async () => {
    await SiteVisit.updateOne({ _id: visit._id }, { $set: { scheduledAt: new Date(Date.now() - 3600000) } });
    const up = await request(app).post('/api/uploads?purpose=verification_photo').set(AG).attach('file', await fx2.photo({ width: 800, height: 600 }), { filename: 'v.jpg', contentType: 'image/jpeg' }).expect(201);
    const other = agents.find((x) => String(x.user._id) !== String(agent.user._id));
    const foreign = await request(app).post('/api/uploads?purpose=verification_photo').set(h.bearer(other.token)).attach('file', await fx2.photo({ width: 800, height: 600 }), { filename: 'f.jpg', contentType: 'image/jpeg' }).expect(201);
    const bad = await request(app).post(`/api/agent/site-visits/${visit._id}/outcome`).set(AG).send({ result: 'completed', interest: 4, photoFileIds: [foreign.body.data.id] });
    expect(bad.status).toBe(422);
    const tooMany = await request(app).post(`/api/agent/site-visits/${visit._id}/outcome`).set(AG).send({ result: 'completed', interest: 4, photoFileIds: Array.from({ length: 11 }, () => new mongoose.Types.ObjectId().toString()) });
    expect(tooMany.status).toBe(422);
    await request(app).post(`/api/agent/site-visits/${visit._id}/outcome`).set(AG).send({ result: 'completed', interest: 4, photoFileIds: [up.body.data.id] }).expect(200);
    expect((await SiteVisit.findById(visit._id)).outcome.photos.map(String)).toEqual([up.body.data.id]);
    const d = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    const row = d.body.data.visits.find((x) => x._id === visit._id);
    expect(row.outcome.photoUrls).toHaveLength(1);
    expect(row.outcome.photoUrls[0].url).toMatch(/verification_photo\//);
  });
});

describe('[C][agent] RE-S-AGT-04 lead detail extras', () => {
  test('linked deal, agent and team names, seeker flag and the next open follow-up', async () => {
    const p = await liveListing(w, lister);
    const { lead, AG, agent } = await newLead(p);
    let d = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    expect(d.body.data).toMatchObject({ deal: null, seekerFlag: null, nextFollowUp: null, agent: { name: agent.user.name }, team: { name: 'Team Seven' } });
    const later = new Date(Date.now() + 2 * 86400000);
    const sooner = new Date(Date.now() + 86400000);
    await request(app).post('/api/agent/followups').set(AG).send({ leadId: String(lead._id), dueAt: later.toISOString(), note: 'Later' }).expect(201);
    await request(app).post('/api/agent/followups').set(AG).send({ leadId: String(lead._id), dueAt: sooner.toISOString(), note: 'Sooner' }).expect(201);
    await request(app).post(`/api/agent/leads/${lead._id}/seeker-flag`).set(AG).send({ note: 'Asked for many owner numbers' }).expect(201);
    const { Deal } = require('../../src/modules/deals/models');
    const ins = await Deal.collection.insertOne({ dealNo: 'DL-TEST-0001', leadId: lead._id, status: 'submitted', createdAt: new Date() });
    d = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    expect(d.body.data.deal).toEqual({ _id: String(ins.insertedId), dealNo: 'DL-TEST-0001', status: 'submitted' });
    expect(d.body.data.nextFollowUp.note).toBe('Sooner');
    expect(d.body.data.seekerFlag).toMatchObject({ flagged: true, status: 'open', rule: 'manual' });
  });
});

describe('[C][agent] RE-K-08 WhatsApp templates', () => {
  test('409 while WhatsApp is off or the buyer has not opted in; sent and logged otherwise', async () => {
    const p = await liveListing(w, lister);
    const { lead, AG } = await newLead(p, { extra: { whatsappOptIn: true } });
    const off = await request(app).post(`/api/agent/leads/${lead._id}/whatsapp-template`).set(AG).send({ template: 'share_listing' });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('WHATSAPP_DISABLED');
    let d = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    expect(d.body.data.whatsapp).toMatchObject({ allowed: false, code: 'WHATSAPP_DISABLED' });

    await settings.set('whatsapp.enabled', true);
    const { lead: noOpt, AG: AG2 } = await newLead(p);
    const r = await request(app).post(`/api/agent/leads/${noOpt._id}/whatsapp-template`).set(AG2).send({ template: 'share_listing' });
    expect(r.body.error.code).toBe('WHATSAPP_NOT_OPTED_IN');

    notify.sent.length = 0;
    const ok = await request(app).post(`/api/agent/leads/${lead._id}/whatsapp-template`).set(AG).send({ template: 'share_listing' }).expect(201);
    expect(ok.body.data).toMatchObject({ sent: true, template: 'share_listing' });
    const msg = notify.sent.find((m) => m.channel === 'whatsapp');
    expect(msg.to).toBe(lead.buyer.phone);
    expect(msg.text).toContain(p.listingNo);
    // visit confirmation needs a scheduled visit
    expect((await request(app).post(`/api/agent/leads/${lead._id}/whatsapp-template`).set(AG).send({ template: 'visit_confirmation' })).status).toBe(422);
    const v = await scheduledVisit(lead, AG, p, istAt(5, '12:00'));
    await request(app).post(`/api/agent/leads/${lead._id}/whatsapp-template`).set(AG).send({ template: 'visit_confirmation', visitId: v._id }).expect(201);
    expect(notify.sent.filter((m) => m.channel === 'whatsapp').pop().text).toContain(v.visitNo);
    const l = await Lead.findById(lead._id);
    expect(l.timeline.filter((t) => t.type === 'whatsapp').map((t) => t.data.template)).toEqual(['share_listing', 'visit_confirmation']);
    d = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    expect(d.body.data.whatsapp.allowed).toBe(true);
    await settings.set('whatsapp.enabled', false);
  });
});

describe('[C][lister] RE-S-LIS-13/17 filters, blackouts and funnel', () => {
  test('visits and activity filter by propertyId and from / to on the server', async () => {
    const p1 = await liveListing(w, lister);
    const p2 = await liveListing(w, lister);
    const a = await newLead(p1);
    const b = await newLead(p2);
    const v1 = await scheduledVisit(a.lead, a.AG, p1, istAt(6, '10:00'));
    const v2 = await scheduledVisit(b.lead, b.AG, p2, istAt(8, '10:00'));
    const visitNos = async (q) => (await request(app).get('/api/lister/visits').query(q).set(lister.t).expect(200)).body.data.items.map((x) => x.visitNo);
    expect(await visitNos({ propertyId: String(p1._id) })).toEqual([v1.visitNo]);
    expect(await visitNos({ from: istAt(7, '00:00').toISOString() })).toContain(v2.visitNo);
    expect(await visitNos({ from: istAt(7, '00:00').toISOString() })).not.toContain(v1.visitNo);
    expect(await visitNos({ upcoming: 'true', to: istAt(7, '00:00').toISOString() })).not.toContain(v2.visitNo);
    expect(await visitNos({ propertyId: new mongoose.Types.ObjectId().toString() })).toEqual([]);

    await request(app).post(`/api/agent/leads/${a.lead._id}/share-update`).set(a.AG).send({ text: 'Buyer liked the balcony', tag: 'interest' }).expect(201);
    const u2 = await request(app).post(`/api/agent/leads/${b.lead._id}/share-update`).set(b.AG).send({ text: 'Buyer wants a second look', tag: 'interest' }).expect(201);
    await ListerUpdate.collection.updateOne({ _id: new mongoose.Types.ObjectId(u2.body.data._id) }, { $set: { createdAt: new Date(Date.now() - 20 * 86400000) } });
    const texts = async (q) => (await request(app).get('/api/lister/activity').query(q).set(lister.t).expect(200)).body.data.map((x) => x.text);
    expect(await texts({ propertyId: String(p1._id) })).toEqual(['Buyer liked the balcony']);
    const recent = await texts({ from: new Date(Date.now() - 86400000).toISOString() });
    expect(recent).toContain('Buyer liked the balcony');
    expect(recent).not.toContain('Buyer wants a second look');
    expect(await texts({ to: new Date(Date.now() - 10 * 86400000).toISOString() })).toEqual(['Buyer wants a second look']);
  });

  test('blackouts have ids; delete by id, the old index route still works, old rows get ids', async () => {
    const from = new Date(Date.now() + 5 * 86400000);
    const to = new Date(Date.now() + 6 * 86400000);
    const r = await request(app).post('/api/lister/availability/blackouts').set(lister.t).send({ from: from.toISOString(), to: to.toISOString(), reason: 'Travel' }).expect(201);
    const b = r.body.data.blackouts.find((x) => x.reason === 'Travel');
    expect(b._id).toMatch(/^[a-f0-9]{24}$/);
    await request(app).delete(`/api/lister/availability/blackouts/${b._id}`).set(lister.t).expect(200);
    let av = await request(app).get('/api/lister/availability').set(lister.t).expect(200);
    expect(av.body.data.availability.blackouts.some((x) => x._id === b._id)).toBe(false);
    expect((await request(app).delete(`/api/lister/availability/blackouts/${b._id}`).set(lister.t)).status).toBe(404);

    await request(app).post('/api/lister/availability/blackouts').set(lister.t).send({ from: from.toISOString(), to: to.toISOString(), reason: 'By index' }).expect(201);
    av = await request(app).get('/api/lister/availability').set(lister.t).expect(200);
    const i = av.body.data.availability.blackouts.findIndex((x) => x.reason === 'By index');
    await request(app).delete(`/api/lister/availability/blackouts/${i}?scope=account`).set(lister.t).expect(200);

    // a blackout stored before ids existed is given one when read
    await VisitAvailability.collection.updateOne({ listerId: lister.user._id, scope: 'account' }, { $push: { blackouts: { from, to, reason: 'Legacy' } } });
    av = await request(app).get('/api/lister/availability').set(lister.t).expect(200);
    const legacy = av.body.data.availability.blackouts.find((x) => x.reason === 'Legacy');
    expect(legacy._id).toMatch(/^[a-f0-9]{24}$/);
    await request(app).delete(`/api/lister/availability/blackouts/${legacy._id}`).set(lister.t).expect(200);
  });

  test('funnel buckets have distinct labels; stages sharing a label are merged on the server before masking', async () => {
    const other = await fx2.verifiedLister('owner');
    const L = other.t;
    const p = await liveListing(w, other);
    const stages = ['contacted', 'qualified', 'qualified', 'negotiation'];
    for (const s of stages) {
      const { lead } = await newLead(p);
      await Lead.updateOne({ _id: lead._id }, { $set: { stage: s } });
    }
    const r = await request(app).get('/api/lister/leads').set(L).expect(200);
    const labels = r.body.data.funnel.map((f) => f.label);
    expect(new Set(labels).size).toBe(labels.length);
    const inTouch = r.body.data.funnel.find((f) => f.label === 'In touch');
    expect(inTouch).toMatchObject({ stages: ['contacted', 'qualified'], count: 3 });
    expect(r.body.data.funnel.find((f) => f.label === 'Negotiating').count).toBe('<3');
    expect(r.body.data.funnel.find((f) => f.label === 'Booked').stages).toEqual(['booking', 'closed_won']);
  });
});
