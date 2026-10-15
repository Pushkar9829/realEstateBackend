// Phase 4 (spec M4) - Module C lead management and Module J teams, plus the
// Phase 3 enquiry capture (RE-C-01..04) and seeker flags (RE-F-10).
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead, SiteVisit, Offer } = require('../../src/modules/leads/models');
const { Notification } = require('../../src/modules/notifications/models');
const { ContactReveal } = require('../../src/modules/reports/models');
const leadJobs = require('../../src/modules/leads/jobs');
const settings = require('../../src/core/settings');
const notify = require('../../src/core/notify');
const { Otp } = require('../../src/modules/auth/models');

let app; let w; let lister; let admin; let A; let manager; let M; let agents; let team;
const istAt = (daysAhead, hhmm, weekday) => {
  // next date (>= daysAhead) whose IST weekday matches, at hh:mm IST
  const now = new Date();
  for (let i = daysAhead; i < daysAhead + 8; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
    if (weekday === undefined || d.getUTCDay() === weekday) {
      const [hh, mm] = hhmm.split(':').map(Number);
      return new Date(d.getTime() + (hh * 60 + mm - 330) * 60000);
    }
  }
  throw new Error('no date');
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
const newPhone = () => { phoneSeq += 1; return `98${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`; };

async function enquire(p, { type = 'enquiry', phone = newPhone(), extra = {} } = {}) {
  const otpToken = await guestToken(phone);
  return request(app).post('/api/leads/enquiry').send({ type, propertyId: String(p._id), name: 'Guest Buyer', otpToken, consent: true, ...extra });
}

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  await settings.set('lead.maxEnquiriesPerIpPerHour', 1000); // every test request comes from one IP
  const a = await h.userWithToken('superadmin');
  admin = a; A = h.bearer(a.token);
  manager = await h.userWithToken('manager', { permissions: ['leads.view_all', 'leads.assign', 'sitevisits.view'] });
  M = h.bearer(manager.token);
  agents = [await h.userWithToken('agent'), await h.userWithToken('agent'), await h.userWithToken('agent')];
  const t = await request(app).post('/api/admin/teams').set(A).send({ name: 'Team West', managerIds: [String(manager.user._id)], members: agents.map((x) => ({ agentId: String(x.user._id) })), territories: { cities: ['Pune'] }, workingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } }).expect(201);
  team = t.body.data;
  await request(app).post('/api/admin/routing-rules').set(A).send({ name: 'Pune', conditions: { cities: ['Pune'] }, teamId: team._id }).expect(201);
});
afterAll(() => mongoose.disconnect());

describe('[J][admin] RE-J-01..07 Teams and routing rules', () => {
  test('an agent can be in one team only; simulator shows the team and agents', async () => {
    const r = await request(app).post('/api/admin/teams').set(A).send({ name: 'Team East', members: [{ agentId: String(agents[0].user._id) }] });
    expect(r.body.error.code).toBe('AGENT_IN_OTHER_TEAM');
    const sim = await request(app).post('/api/admin/routing-rules/simulate').set(A).send({ city: 'Pune', purpose: 'sale' }).expect(200);
    expect(sim.body.data.team.name).toBe('Team West');
    expect(sim.body.data.agents).toHaveLength(3);
  });

  test('managers see only their teams; routing rules need routing.manage', async () => {
    const list = await request(app).get('/api/admin/teams').set(M).expect(200);
    expect(list.body.data.map((t) => t.name)).toEqual(['Team West']);
    expect((await request(app).get('/api/admin/routing-rules').set(M)).status).toBe(403);
  });
});

describe('[C][public] RE-C-01/03/04 Enquiry capture', () => {
  test('guests need a verified phone; a lister cannot enquire on their own listing', async () => {
    const p = await liveListing(w, lister);
    const r = await request(app).post('/api/leads/enquiry').send({ propertyId: String(p._id), phone: '9876501234', consent: true });
    expect(r.body.error.code).toBe('OTP_REQUIRED');
    const self = await request(app).post('/api/leads/enquiry').set(lister.t).send({ propertyId: String(p._id), consent: true });
    expect(self.body.error.code).toBe('SELF_ENQUIRY');
  });

  test('acceptance C1: same phone + property twice in 7 days = one lead with two timeline entries', async () => {
    const p = await liveListing(w, lister);
    const phone = newPhone();
    const a = await enquire(p, { phone });
    expect(a.status).toBe(201);
    const b = await enquire(p, { phone, type: 'best_price' });
    expect(b.body.data).toMatchObject({ leadNo: a.body.data.leadNo, merged: true });
    const lead = await Lead.findOne({ leadNo: a.body.data.leadNo });
    expect(lead.timeline.filter((t) => ['created', 'merged'].includes(t.type))).toHaveLength(2);
    expect(lead.priority).toBe('hot');
    expect(lead.buyerLabel).toBe('Buyer 1');
    expect(await Notification.exists({ userId: lister.user._id, eventKey: 'lead.lister_new' })).toBeTruthy();
  });

  test('acceptance C2/C3: round-robin A, B, C, A, B, C; an away agent gets nothing', async () => {
    const p = await liveListing(w, lister);
    const got = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await enquire(p);
      got.push(String((await Lead.findOne({ leadNo: r.body.data.leadNo })).assignedTo));
    }
    expect(got.slice(0, 3)).toEqual(got.slice(3));
    expect(new Set(got.slice(0, 3)).size).toBe(3);
    await request(app).patch('/api/agent/availability').set(h.bearer(agents[0].token)).send({ available: false }).expect(200);
    for (let i = 0; i < 4; i += 1) {
      const r = await enquire(p);
      expect(String((await Lead.findOne({ leadNo: r.body.data.leadNo })).assignedTo)).not.toBe(String(agents[0].user._id));
    }
    await request(app).patch('/api/agent/availability').set(h.bearer(agents[0].token)).send({ available: true }).expect(200);
  });

  test('requirement form: source requirement, no property, routed by city; twice in 7 days = one lead (E10, C15)', async () => {
    const phone = newPhone();
    const otpToken = await guestToken(phone);
    const body = { name: 'Req Buyer', otpToken, city: 'Pune', purpose: 'sale', bhk: [2], budgetMax: 9000000, consent: true };
    const a = await request(app).post('/api/leads/requirement').send(body).expect(200);
    const b = await request(app).post('/api/leads/requirement').send({ ...body, otpToken: await guestToken(phone) }).expect(200);
    expect(b.body.data).toMatchObject({ leadNo: a.body.data.leadNo, merged: true });
    const lead = await Lead.findOne({ leadNo: a.body.data.leadNo });
    expect(lead.sources).toEqual(['requirement']);
    expect(lead.propertyId).toBeFalsy();
    expect(String(lead.teamId)).toBe(team._id);
  });

  test('more than 5 enquiries a day from one phone are refused', async () => {
    const phone = newPhone();
    let last;
    for (let i = 0; i < 6; i += 1) { const p = await liveListing(w, lister); last = await enquire(p, { phone }); }
    expect(last.status).toBe(429);
  });
});

describe('[C][agent] RE-C-06/08/09 SLA, stages, calls', () => {
  let lead; let AG;
  beforeAll(async () => {
    const p = await liveListing(w, lister);
    const r = await enquire(p);
    lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    AG = h.bearer(agents.find((x) => String(x.user._id) === String(lead.assignedTo)).token);
  });

  test('acceptance C4: past-due new lead is breached by the sweep and the manager is notified', async () => {
    await Lead.updateOne({ _id: lead._id }, { $set: { slaDueAt: new Date(Date.now() - 60000) } });
    await leadJobs.slaSweep();
    expect((await Lead.findById(lead._id)).slaBreachedAt).toBeTruthy();
    expect(await Notification.exists({ userId: manager.user._id, eventKey: 'lead.sla_breached' })).toBeTruthy();
  });

  test('acceptance C5: closed_won / booking cannot be set from the board; lost needs a reason and 3 attempts for not responding', async () => {
    expect((await request(app).patch(`/api/agent/leads/${lead._id}/stage`).set(AG).send({ stage: 'closed_won' })).status).toBe(422);
    expect((await request(app).patch(`/api/agent/leads/${lead._id}/stage`).set(AG).send({ stage: 'booking' })).status).toBe(422);
    expect((await request(app).patch(`/api/agent/leads/${lead._id}/stage`).set(AG).send({ stage: 'closed_lost', lostReason: 'not_responding' })).status).toBe(422);
  });

  test('a connected call moves new -> contacted and stops the SLA; other agents cannot open the lead', async () => {
    await request(app).post(`/api/agent/leads/${lead._id}/calls`).set(AG).send({ outcome: 'connected', durationSec: 120 }).expect(201);
    const l = await Lead.findById(lead._id);
    expect(l.stage).toBe('contacted');
    expect(l.firstContactAt).toBeTruthy();
    const other = agents.find((x) => String(x.user._id) !== String(lead.assignedTo));
    expect((await request(app).get(`/api/agent/leads/${lead._id}`).set(h.bearer(other.token))).status).toBe(403);
    const detail = await request(app).get(`/api/agent/leads/${lead._id}`).set(AG).expect(200);
    expect(detail.body.data.buyer.phone).toMatch(/•/);
  });

  test('reveal is audited (RE-B-10)', async () => {
    const r = await request(app).post(`/api/agent/leads/${lead._id}/reveal-contact`).set(AG).send({ field: 'phone' }).expect(200);
    expect(r.body.data.value).toMatch(/^\+91/);
    expect(await ContactReveal.countDocuments({ leadId: lead._id })).toBe(1);
  });

  test('follow-ups: create, buckets, complete', async () => {
    const f = await request(app).post('/api/agent/followups').set(AG).send({ leadId: String(lead._id), dueAt: new Date(Date.now() + 3600000).toISOString(), note: 'Call back' }).expect(201);
    const b = await request(app).get('/api/agent/followups').set(AG).expect(200);
    expect([...b.body.data.today, ...b.body.data.upcoming].some((x) => x._id === f.body.data._id)).toBe(true);
    await request(app).post(`/api/agent/followups/${f.body.data._id}/complete`).set(AG).send({ outcome: 'Spoke, wants a visit' }).expect(200);
    const today = await request(app).get('/api/agent/dashboard').set(AG).expect(200);
    expect(today.body.data.counts.open).toBeGreaterThan(0);
  });
});

describe('[C][agent][lister] RE-C-12..16/19 Visits and availability', () => {
  let lead; let AG; let p;
  beforeAll(async () => {
    p = await liveListing(w, lister);
    const r = await enquire(p);
    lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    AG = h.bearer(agents.find((x) => String(x.user._id) === String(lead.assignedTo)).token);
  });

  test('acceptance C10: Saturday-only slots -> Monday is 422 for the agent, allowed for a manager with a reason', async () => {
    await request(app).put('/api/lister/availability').set(lister.t).send({ weekly: [{ day: 6, start: '09:00', end: '13:00' }], noticeHours: 2 }).expect(200);
    const monday = istAt(2, '10:00', 1);
    const r = await request(app).post('/api/agent/site-visits').set(AG).send({ leadId: String(lead._id), propertyId: String(p._id), scheduledAt: monday.toISOString() });
    expect(r.status).toBe(422);
    const ok = await request(app).post('/api/agent/site-visits').set(M).send({ leadId: String(lead._id), propertyId: String(p._id), scheduledAt: monday.toISOString(), overrideReason: 'Owner agreed by phone' }).expect(201);
    expect(ok.body.data.outsideListerSlots).toBe(true);
    const lv = await request(app).get('/api/lister/visits').set(lister.t).expect(200);
    const row = lv.body.data.items.find((x) => x.visitNo === ok.body.data.visitNo);
    expect(row).toMatchObject({ outsideListerSlots: true, overrideReason: 'Owner agreed by phone', buyer: 'Buyer 1' });
    await request(app).put('/api/lister/availability').set(lister.t).send({ weekly: [], noticeHours: 2 }).expect(200);
  });

  test('acceptance C6: an overlapping visit for the same agent is 409', async () => {
    const v = await SiteVisit.findOne({ leadId: lead._id });
    const r = await request(app).post('/api/agent/site-visits').set(AG).send({ leadId: String(lead._id), propertyId: String(p._id), scheduledAt: v.scheduledAt.toISOString() });
    expect(r.body.error.code).toBe('VISIT_OVERLAP');
  });

  test('acceptance C7/C8/C13: completed outcome -> site_visit_done; lister sees Buyer N; one feedback per token', async () => {
    const v = await SiteVisit.findOne({ leadId: lead._id });
    await SiteVisit.updateOne({ _id: v._id }, { $set: { scheduledAt: new Date(Date.now() - 3600000) } });
    await request(app).post(`/api/agent/site-visits/${v._id}/outcome`).set(AG).send({ result: 'completed', interest: 4, nextStep: 'Negotiate', shareWithLister: true }).expect(200);
    expect((await Lead.findById(lead._id)).stage).toBe('site_visit_done');
    const act = await request(app).get('/api/lister/activity').set(lister.t).expect(200);
    expect(act.body.data[0].buyer).toMatch(/^Buyer \d+$/);
    expect(JSON.stringify(act.body)).not.toMatch(/Guest Buyer|\+9198/);
    const job = await require('../../src/core/jobs').Job.findOne({ type: 'sitevisit.feedback_request' });
    await leadJobs.feedbackRequest(job.payload);
    const token = job.payload.token;
    const form = await request(app).get(`/api/site-visits/feedback/${token}`).expect(200);
    expect(form.body.data.submitted).toBe(false);
    await request(app).post(`/api/site-visits/feedback/${token}`).send({ interest: 5, callBack: true }).expect(200);
    expect((await request(app).post(`/api/site-visits/feedback/${token}`).send({ interest: 3 })).status).toBe(409);
  });

  test('acceptance C11/C12: counter then accept -> 3 rounds; buyer sees the counter only after relay', async () => {
    const o = await request(app).post(`/api/agent/leads/${lead._id}/offers`).set(AG).send({ amount: 8000000, validityDays: 7 }).expect(201);
    expect((await Lead.findById(lead._id)).stage).toBe('negotiation');
    const inbox = await request(app).get('/api/lister/offers').set(lister.t).expect(200);
    expect(inbox.body.data[0]).toMatchObject({ buyer: 'Buyer 1', canRespond: true });
    await request(app).post(`/api/lister/offers/${o.body.data._id}/respond`).set(lister.t).send({ action: 'counter', amount: 8300000 }).expect(200);
    // buyer tracker: counter not visible yet
    const buyerUser = await h.userWithToken('buyer', { phone: lead.buyer.phone });
    const before = await request(app).get(`/api/me/enquiries/${lead._id}`).set(h.bearer(buyerUser.token)).expect(200);
    expect(before.body.data.offers[0].lastAmount).toBe(800000000);
    expect((await request(app).post(`/api/agent/offers/${o.body.data._id}/rounds`).set(AG).send({ kind: 'accept' })).body.error.code).toBe('NOT_RELAYED');
    await request(app).post(`/api/agent/offers/${o.body.data._id}/relay`).set(AG).expect(200);
    const after = await request(app).get(`/api/me/enquiries/${lead._id}`).set(h.bearer(buyerUser.token)).expect(200);
    expect(after.body.data.offers[0].lastAmount).toBe(830000000);
    await request(app).post(`/api/agent/offers/${o.body.data._id}/rounds`).set(AG).send({ kind: 'accept' }).expect(200);
    const final = await Offer.findById(o.body.data._id);
    expect(final.status).toBe('accepted');
    expect(final.rounds).toHaveLength(3);
    expect((await Lead.findById(lead._id)).timeline.filter((t) => t.type === 'offer')).toHaveLength(3);
    // acceptance C9: simplified labels only
    const list = await request(app).get('/api/me/enquiries').set(h.bearer(buyerUser.token)).expect(200);
    expect(list.body.data[0].status).toBe('Negotiating');
    expect(JSON.stringify(list.body)).not.toMatch(/negotiation|assignedTo|timeline/);
  });
});

describe('[C][admin] RE-C-06/07 Manager queue and lead admin', () => {
  test('unassigned queue, assign, reopen within 30 days, merge, export without contacts for managers', async () => {
    const p = await liveListing(w, lister);
    const r1 = await enquire(p);
    const l1 = await Lead.findOne({ leadNo: r1.body.data.leadNo });
    await Lead.updateOne({ _id: l1._id }, { $unset: { assignedTo: 1 } });
    const q = await request(app).get('/api/admin/leads/queue').set(M).expect(200);
    expect(q.body.data.unassigned.map((x) => x.leadNo)).toContain(l1.leadNo);
    await request(app).post(`/api/admin/leads/${l1._id}/assign`).set(M).send({ agentId: String(agents[1].user._id), reason: 'Balance' }).expect(200);
    expect(String((await Lead.findById(l1._id)).assignedTo)).toBe(String(agents[1].user._id));
    const outsider = await h.userWithToken('agent');
    expect((await request(app).post(`/api/admin/leads/${l1._id}/assign`).set(M).send({ agentId: String(outsider.user._id) })).status).toBe(403);

    const AGb = h.bearer(agents[1].token);
    for (let i = 0; i < 3; i += 1) await request(app).post(`/api/agent/leads/${l1._id}/calls`).set(AGb).send({ outcome: 'no_answer' }).expect(201);
    await request(app).patch(`/api/agent/leads/${l1._id}/stage`).set(AGb).send({ stage: 'closed_lost', lostReason: 'not_responding' }).expect(200);
    await request(app).post(`/api/admin/leads/${l1._id}/reopen`).set(M).send({ note: 'Buyer called back' }).expect(200);
    expect((await Lead.findById(l1._id)).stage).toBe('new');

    const csv = await request(app).get('/api/admin/leads/export').set(h.bearer((await h.userWithToken('admin', { permissions: ['leads.export'] })).token)).expect(200);
    expect(csv.text.split('\n')[0]).not.toMatch(/buyerPhone/);
    const csvAdmin = await request(app).get('/api/admin/leads/export').set(A).expect(200);
    expect(csvAdmin.text.split('\n')[0]).toMatch(/buyerPhone/);
  });
});

describe('[F][admin] RE-F-10 Seeker behaviour flags', () => {
  test('a phone enquiring on more than 10 listers in 7 days is throttled', async () => {
    await settings.set('lead.maxEnquiriesPerPhonePerDay', 50);
    const phone = newPhone();
    const fx2 = require('../phase2/fixtures');
    for (let i = 0; i < 11; i += 1) {
      const other = await fx2.verifiedLister('owner');
      const p = await liveListing(w, other);
      await enquire(p, { phone });
    }
    const flags = await request(app).get('/api/admin/seeker-flags').set(A).expect(200);
    expect(flags.body.data.length).toBe(1);
    expect(flags.body.data[0]).toMatchObject({ action: 'throttle', counts: expect.objectContaining({ listers: 11 }) });
    const p = await liveListing(w, (await fx2.verifiedLister('owner')));
    // Throttled: 1 enquiry a day, and this phone already made 11 today.
    const r = await enquire(p, { phone });
    expect(r.status).toBe(429);
    await request(app).patch(`/api/admin/seeker-flags/${flags.body.data[0]._id}`).set(A).send({ action: 'block', note: 'Broker scraping' }).expect(200);
    const blocked = await request(app).post('/api/leads/otp').send({ phone });
    expect(blocked.body.error.code).toBe('SEEKER_BLOCKED');
    notify.sent.length = 0;
  });
});
