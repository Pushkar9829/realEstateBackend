// Phase 8 spec-gap pass: leads, notifications, WhatsApp, MLM and reports.
//   RE-F-10 acceptance 7 (blocked == rate-limited) and seeker.flagged_lead
//   RE-K-08 WhatsApp channel (opt-in, opt-out, SMS fallback, quick replies, Meta adapter)
//   RE-K acceptance 1 (dead job in the admin list) and delayed reminder jobs
//   RE-D-08 commission breakdown and receivables by city
//   RE-N-01/02/04/07 referral capture, lifetime attribution, HMAC, backoff, user.signup
//   RE-O acceptance 1, RE-C-02 manual leads, RE-B-05 masking
//   section 5 notifications: offer.expired, sitevisit.outcome_pending, report.sla_warning
//   notification links point to real frontend routes
const fs = require('fs');
const path = require('path');
const http = require('http');
const axios = require('axios');
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx2 = require('../phase2/fixtures');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead, SiteVisit, Offer } = require('../../src/modules/leads/models');
const { Notification } = require('../../src/modules/notifications/models');
const { User, Consent, Otp } = require('../../src/modules/auth/models');
const { SeekerFlag, Blocklist } = require('../../src/modules/kyc/models');
const { Deal } = require('../../src/modules/deals/models');
const { Receivable } = require('../../src/modules/receivables/models');
const { Property } = require('../../src/modules/listings/models');
const { ListingReport } = require('../../src/modules/search/models');
const { AuditLog } = require('../../src/core/audit');
const jobs = require('../../src/core/jobs');
const outbox = require('../../src/core/outbox');
const env = require('../../src/config/env');
const settings = require('../../src/core/settings');
const notify = require('../../src/core/notify');
const { hmacSha256 } = require('../../src/core/security/crypto');
const seeker = require('../../src/modules/kyc/seeker.service');
const leadJobs = require('../../src/modules/leads/jobs');
const buyerSvc = require('../../src/modules/leads/buyer.service');
const searchSvc = require('../../src/modules/search/service');
const notifications = require('../../src/modules/notifications/service');
const DEFAULTS = require('../../src/modules/notifications/templates');

let app; let w; let lister; let admin; let A; let manager; let M; let agents; let team;
const { Job } = jobs;

// Only the handlers these tests need (no recurring schedules, so tick() runs queued jobs only).
jobs.register('notify.sms', (p) => notify.sendSms(p));
jobs.register('notify.whatsapp', (p) => notifications.deliverWhatsapp(p));
jobs.register('test.always_fail', async () => { throw new Error('engine down'); });
require('../../src/modules/mlm').register(); // events.USER_REGISTERED -> user.signup

async function guestToken(phone) {
  await h.resetOtpLimits(h.e164(phone));
  await request(app).post('/api/leads/otp').send({ phone }).expect(200);
  const code = h.otpFor(h.e164(phone));
  const r = await request(app).post('/api/leads/otp/verify').send({ phone, code }).expect(200);
  await Otp.deleteMany({ target: h.e164(phone) });
  return r.body.data.otpToken;
}

let phoneSeq = 0;
const newPhone = () => { phoneSeq += 1; return `97${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`; };

async function enquire(p, { phone = newPhone(), otpToken, extra = {}, auth } = {}) {
  const token = otpToken || (auth ? undefined : await guestToken(phone));
  const r = request(app).post('/api/leads/enquiry');
  if (auth) r.set(auth);
  return r.send({ type: 'enquiry', propertyId: String(p._id), name: 'Guest Buyer', ...(token ? { otpToken: token } : {}), consent: true, ...extra });
}

async function enquireOk(p, opts) {
  const r = await enquire(p, opts);
  if (r.status !== 201) throw new Error(`enquiry failed: ${JSON.stringify(r.body)}`);
  return r;
}

const waitFor = async (fn, ms = 3000) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > until) return v;
    await new Promise((r) => { setTimeout(r, 50); });
  }
};

// Run only the queued jobs of the given ids (others are parked meanwhile).
async function runJobs(ids) {
  const parked = await Job.find({ status: 'queued', _id: { $nin: ids } }).distinct('_id');
  await Job.updateMany({ _id: { $in: parked } }, { $set: { status: 'running', lockedUntil: new Date(Date.now() + 3600000) } });
  await Job.updateMany({ _id: { $in: ids } }, { $set: { runAt: new Date() } });
  await jobs.tick();
  await Job.updateMany({ _id: { $in: parked } }, { $set: { status: 'queued' }, $unset: { lockedUntil: 1 } });
}

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  await settings.set('lead.maxEnquiriesPerIpPerHour', 1000);
  await settings.set('notify.quietHours', '00:00-00:00'); // no quiet window: jobs are due at once
  admin = await h.userWithToken('superadmin');
  A = h.bearer(admin.token);
  manager = await h.userWithToken('manager', { permissions: ['leads.view_all', 'leads.assign', 'reports.view'] });
  M = h.bearer(manager.token);
  agents = [await h.userWithToken('agent'), await h.userWithToken('agent')];
  const t = await request(app).post('/api/admin/teams').set(A).send({ name: 'Team Comms', managerIds: [String(manager.user._id)], members: agents.map((x) => ({ agentId: String(x.user._id) })), territories: { cities: ['Pune'] }, workingHours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } }).expect(201);
  team = t.body.data;
  await request(app).post('/api/admin/routing-rules').set(A).send({ name: 'Pune', conditions: { cities: ['Pune'] }, teamId: team._id }).expect(201);
});
afterAll(() => mongoose.disconnect());

// ---------------------------------------------------------------- F

describe('[F][public] RE-F-10 seeker flags', () => {
  test('acceptance 7: a blocked phone and a rate-limited phone get the same answer; the audit keeps the reason', async () => {
    await settings.set('lead.maxEnquiriesPerPhonePerDay', 1);
    const limited = newPhone();
    await enquireOk(await liveListing(w, lister), { phone: limited });
    const tooMany = await enquire(await liveListing(w, lister), { phone: limited });

    const blockedPhone = newPhone();
    const token = await guestToken(blockedPhone); // verified before the block
    await Blocklist.create({ type: 'seeker_phone', valueHash: seeker.phoneHash(h.e164(blockedPhone)), reason: 'test block' });
    const blocked = await enquire(await liveListing(w, lister), { otpToken: token });
    const blockedOtp = await request(app).post('/api/leads/otp').send({ phone: blockedPhone });
    await settings.set('lead.maxEnquiriesPerPhonePerDay', 5);

    expect(tooMany.status).toBe(429);
    for (const r of [blocked, blockedOtp]) {
      expect(r.status).toBe(tooMany.status);
      expect(r.body.error).toEqual(expect.objectContaining({ code: tooMany.body.error.code, message: tooMany.body.error.message }));
      expect(JSON.stringify(r.body)).not.toMatch(/block|seeker|flag/i);
    }
    const reasons = (await AuditLog.find({ action: 'lead.enquiry_refused' }).lean()).map((x) => x.reason);
    expect(reasons).toEqual(expect.arrayContaining(['phone_limit', 'seeker_blocked']));
  });

  test('seeker.flagged_lead: the agent of a new lead from a flagged phone is told', async () => {
    const phone = newPhone();
    await SeekerFlag.create({ flagNo: `SF-T-${Date.now()}`, phoneHash: seeker.phoneHash(h.e164(phone)), phoneMasked: '+91******00', rule: 'manual', status: 'open', action: 'none' });
    const r = await enquireOk(await liveListing(w, lister), { phone });
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    expect(lead.assignedTo).toBeTruthy();
    expect(lead.seekerFlagId).toBeTruthy();
    const n = await Notification.findOne({ userId: lead.assignedTo, eventKey: 'seeker.flagged_lead' });
    expect(n.title).toContain(lead.leadNo);
    expect(n.link).toBe(`/agent/leads/${lead._id}`);
  });
});

// ---------------------------------------------------------------- K

describe('[K][system] RE-K-08 WhatsApp channel', () => {
  beforeAll(async () => {
    await settings.set('whatsapp.enabled', true);
    await settings.set('whatsapp.events', ['lead.received', 'visit.scheduled', 'visit.reminder', 'listing.check']);
  });
  afterAll(async () => { await settings.set('whatsapp.enabled', false); });

  const waJobs = (to) => Job.find({ type: 'notify.whatsapp', 'payload.to': to }).sort({ createdAt: 1 });

  test('opted-in guest: the acknowledgement is a notify.whatsapp job (no SMS now) and is delivered on WhatsApp', async () => {
    const phone = newPhone();
    notify.sent.length = 0;
    const r = await enquireOk(await liveListing(w, lister), { phone, extra: { whatsappOptIn: true } });
    const [job] = await waJobs(h.e164(phone));
    expect(job.payload).toMatchObject({ event: 'lead.created', template: { name: 'lead_acknowledgement', params: ['Guest Buyer', r.body.data.leadNo] } });
    expect(job.payload.fallbackSms.text).toContain(r.body.data.leadNo);
    expect(notify.sent.filter((m) => m.to === h.e164(phone) && m.channel === 'sms' && m.text.includes(r.body.data.leadNo))).toHaveLength(0);
    await runJobs([job._id]);
    const wa = notify.sent.find((m) => m.channel === 'whatsapp' && m.to === h.e164(phone));
    expect(wa.text).toContain(r.body.data.leadNo);
    expect((await Job.findById(job._id)).status).toBe('done');
  });

  test('not opted in: no notify.whatsapp job ever, the SMS goes as before', async () => {
    const phone = newPhone();
    notify.sent.length = 0;
    const r = await enquireOk(await liveListing(w, lister), { phone });
    expect(await waJobs(h.e164(phone))).toHaveLength(0);
    expect(notify.sent.find((m) => m.channel === 'sms' && m.to === h.e164(phone) && m.text.includes(r.body.data.leadNo))).toBeTruthy();
    // visit reminder for the same buyer: SMS, still no WhatsApp
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    const v = await SiteVisit.create({ visitNo: `V-T-${Date.now()}`, leadId: lead._id, propertyId: lead.propertyId, agentId: lead.assignedTo, scheduledAt: new Date(Date.now() + 86400000), status: 'scheduled' });
    await leadJobs.visitReminder({ visitId: v._id, kind: 'buyer24', scheduledAt: v.scheduledAt });
    expect(await waJobs(h.e164(phone))).toHaveLength(0);
  });

  test('opt-out: a registered buyer who withdrew whatsapp_updates gets SMS jobs, not WhatsApp', async () => {
    const buyer = await h.registerActive(app, 'buyer');
    const B = h.bearer(buyer.accessToken);
    const r = await enquireOk(await liveListing(w, lister), { auth: B, extra: { whatsappOptIn: true } });
    expect(await waJobs(buyer.phoneE164)).toHaveLength(1); // opted in at enquiry
    await request(app).post('/api/me/consents/whatsapp_updates/withdraw').set(B).expect(200);
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    const v = await SiteVisit.create({ visitNo: `V-T-${Date.now()}`, leadId: lead._id, propertyId: lead.propertyId, agentId: lead.assignedTo, scheduledAt: new Date(Date.now() + 86400000), status: 'scheduled' });
    await leadJobs.visitReminder({ visitId: v._id, kind: 'buyer24', scheduledAt: v.scheduledAt });
    expect(await waJobs(buyer.phoneE164)).toHaveLength(1);
    expect(await Job.exists({ type: 'notify.sms', 'payload.to': buyer.phoneE164, 'payload.text': new RegExp(v.visitNo) })).toBeTruthy();
    // and the agent can no longer send templates to this buyer
    const AG = h.bearer(agents.find((a) => String(a.user._id) === String(lead.assignedTo)).token);
    const t = await request(app).post(`/api/agent/leads/${lead._id}/whatsapp-template`).set(AG).send({ template: 'share_listing' });
    expect(t.body.error.code).toBe('WHATSAPP_NOT_OPTED_IN');
  });

  test('fallback: a failed WhatsApp send delivers the SMS instead; visit reminders go on WhatsApp', async () => {
    const phone = newPhone();
    const r = await enquireOk(await liveListing(w, lister), { phone, extra: { whatsappOptIn: true } });
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    const v = await SiteVisit.create({ visitNo: `V-T-${Date.now()}`, leadId: lead._id, propertyId: lead.propertyId, agentId: lead.assignedTo, scheduledAt: new Date(Date.now() + 86400000), status: 'scheduled', meetingPoint: 'Main gate' });
    await leadJobs.visitReminder({ visitId: v._id, kind: 'buyer2', scheduledAt: v.scheduledAt });
    const job = (await waJobs(h.e164(phone))).find((j) => j.payload.event === 'sitevisit.reminder');
    expect(job.payload.template.name).toBe('visit_reminder');
    notify.sent.length = 0;
    notify.sendWhatsapp.failNext = true;
    await runJobs([job._id]);
    expect(notify.sent.find((m) => m.channel === 'whatsapp' && m.to === h.e164(phone))).toBeFalsy();
    const sms = notify.sent.find((m) => m.channel === 'sms' && m.to === h.e164(phone));
    expect(sms.text).toContain(v.visitNo);
    expect((await Job.findById(job._id)).status).toBe('done');
  });

  test('"still available?" goes with quick replies check:<token>:<answer> to an opted-in lister', async () => {
    const l = await fx2.verifiedLister('owner');
    await Consent.create({ subjectType: 'user', subjectId: l.user._id, purpose: 'whatsapp_updates', source: 'registration' });
    await notifications.notifyUser({ user: l.user, event: 'listing.availability_check', channels: ['sms', 'email', 'in_app'], vars: { listingNo: 'RE-P-1', title: 'Flat', dueBy: '1 Jan', propertyId: 'x', link: `${env.CLIENT_URL}/listing-check/TOK123` } });
    const [job] = await waJobs(l.user.phone);
    expect(job.payload.buttons.map((b) => b.payload)).toEqual(['check:TOK123:available', 'check:TOK123:sold', 'check:TOK123:pause']);
    expect(await Job.exists({ type: 'notify.sms', 'payload.to': l.user.phone })).toBeFalsy(); // WhatsApp replaces the SMS
  });

  test('Meta Cloud API adapter: template message with quick-reply payloads to graph.facebook.com', async () => {
    const saved = { isTest: env.isTest, provider: env.WHATSAPP_PROVIDER, id: env.WHATSAPP_PHONE_NUMBER_ID, token: env.WHATSAPP_ACCESS_TOKEN };
    const spy = jest.spyOn(axios, 'post').mockResolvedValue({ data: { messages: [{ id: 'wamid.T1' }] } });
    Object.assign(env, { isTest: false, WHATSAPP_PROVIDER: 'meta', WHATSAPP_PHONE_NUMBER_ID: '1234567', WHATSAPP_ACCESS_TOKEN: 'tok-abc' });
    try {
      const r = await notify.sendWhatsapp({ to: '+919812345678', text: 'Is it available?', template: { name: 'listing_availability_check', language: 'en', params: ['RE-P-1'] }, buttons: [{ title: 'Pause', payload: 'check:T:pause' }] });
      expect(r).toEqual({ provider: 'meta', id: 'wamid.T1' });
      const [url, body, opts] = spy.mock.calls[0];
      expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/1234567\/messages$/);
      expect(opts.headers.Authorization).toBe('Bearer tok-abc');
      expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919812345678', type: 'template', template: { name: 'listing_availability_check', language: { code: 'en' } } });
      expect(body.template.components).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: 'RE-P-1' }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'check:T:pause' }] },
      ]);
    } finally {
      Object.assign(env, { isTest: saved.isTest, WHATSAPP_PROVIDER: saved.provider, WHATSAPP_PHONE_NUMBER_ID: saved.id, WHATSAPP_ACCESS_TOKEN: saved.token });
      spy.mockRestore();
    }
  });
});

describe('[K][admin] notification jobs', () => {
  test('acceptance 1: a job failing 5 times is dead and listed in GET /api/admin/jobs', async () => {
    const job = await jobs.enqueue('test.always_fail', { n: 1 });
    for (let i = 0; i < 5; i += 1) await runJobs([job._id]);
    const j = await Job.findById(job._id);
    expect(j).toMatchObject({ status: 'dead', attempts: 5, lastError: 'engine down' });
    const list = await request(app).get('/api/admin/jobs?status=dead').set(A).expect(200);
    expect(list.body.data.map((x) => String(x._id))).toContain(String(job._id));
  });

  test('RE-K-06: scheduling a visit creates delayed reminder jobs (24 h, 2 h buyer; 1 h agent; 24 h lister)', async () => {
    const p = await liveListing(w, lister);
    const r = await enquireOk(p);
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    const at = new Date(Date.now() + 3 * 86400000);
    const v = await SiteVisit.create({ visitNo: `V-T-${Date.now()}`, leadId: lead._id, propertyId: p._id, agentId: lead.assignedTo, scheduledAt: at, status: 'scheduled' });
    await buyerSvc.scheduleReminders(v);
    const rows = await Job.find({ type: 'sitevisit.reminder', 'payload.visitId': String(v._id) }).lean();
    expect(rows.map((x) => x.payload.kind).sort()).toEqual(['agent1', 'buyer2', 'buyer24', 'lister24']);
    const buyer2 = rows.find((x) => x.payload.kind === 'buyer2');
    expect(Math.abs(new Date(buyer2.runAt).getTime() - (at.getTime() - 2 * 3600000))).toBeLessThan(5000);
    expect(rows.every((x) => x.status === 'queued' && new Date(x.runAt) > new Date())).toBe(true);
  });
});

// ---------------------------------------------------------------- section 5 notifications

describe('[K][system] notifications from the matrix', () => {
  test('offer.expired goes to the agent and the lister', async () => {
    const p = await liveListing(w, lister);
    const r = await enquireOk(p);
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    const o = await Offer.create({ offerNo: `OF-T-${Date.now()}`, leadId: lead._id, propertyId: p._id, listerId: lister.user._id, agentId: lead.assignedTo, buyerLabel: lead.buyerLabel, status: 'awaiting_lister', validUntil: new Date(Date.now() - 60000), rounds: [] });
    await leadJobs.offerSweep();
    expect((await Offer.findById(o._id)).status).toBe('expired');
    for (const [id, link] of [[lead.assignedTo, `/agent/leads/${lead._id}`], [lister.user._id, '/lister/offers']]) {
      const n = await Notification.findOne({ userId: id, eventKey: 'offer.expired' });
      expect(n.title).toContain(o.offerNo);
      expect(n.link).toBe(link);
    }
  });

  test('sitevisit.outcome_pending: 24 h after the slot without an outcome, agent and manager are told once', async () => {
    const p = await liveListing(w, lister);
    const r = await enquireOk(p);
    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    const v = await SiteVisit.create({ visitNo: `V-OP-${Date.now()}`, leadId: lead._id, propertyId: p._id, agentId: lead.assignedTo, scheduledAt: new Date(Date.now() - 30 * 3600000), status: 'scheduled' });
    await leadJobs.outcomePending();
    await leadJobs.outcomePending(); // second run: no repeat
    for (const id of [lead.assignedTo, manager.user._id]) {
      const rows = await Notification.find({ userId: id, eventKey: 'sitevisit.outcome_pending', title: new RegExp(v.visitNo) });
      expect(rows).toHaveLength(1);
      expect(rows[0].link).toBe(`/${String(id) === String(manager.user._id) ? 'admin' : 'agent'}/leads/${lead._id}`);
    }
  });

  test('report.sla_warning: reports in the amber band reach admins with properties.manage, once', async () => {
    const p = await liveListing(w, lister);
    const propAdmin = await h.userWithToken('admin', { permissions: ['properties.manage'] });
    const rep = await ListingReport.create({ reportNo: `RPT-T-${Date.now()}`, propertyId: p._id, reason: 'wrong_info', status: 'open' });
    await ListingReport.collection.updateOne({ _id: rep._id }, { $set: { createdAt: new Date(Date.now() - 20 * 3600000) } });
    const fresh = await ListingReport.create({ reportNo: `RPT-F-${Date.now()}`, propertyId: p._id, reason: 'other', status: 'open' });
    expect(await searchSvc.reportSlaWarning()).toBe(1);
    expect(await searchSvc.reportSlaWarning()).toBe(0);
    for (const u of [propAdmin.user, admin.user]) {
      const n = await Notification.findOne({ userId: u._id, eventKey: 'report.sla_warning' });
      expect(n.body).toContain(rep.reportNo);
      expect(n.body).not.toContain(fresh.reportNo);
      expect(n.link).toBe('/admin/feedback');
    }
  });
});

describe('[K] notification links', () => {
  // Route patterns read from the frontend route files, plus pages another change adds.
  function knownRoutes() {
    const root = path.join(__dirname, '../../../frontend/src/panels');
    const bases = { admin: '/admin', agent: '/agent', lister: '/lister', public: '' };
    const out = new Set(['/', '/admin', '/agent', '/lister', '/lister/listings/:id']);
    for (const [dir, base] of Object.entries(bases)) {
      for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => /^routes.*\.jsx$/.test(x))) {
        const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
        for (const m of src.matchAll(/path:\s*'([^']+)'/g)) out.add(m[1].startsWith('/') ? m[1] : `${base}/${m[1]}`);
      }
    }
    return [...out].map((r) => new RegExp(`^${r.replace(/:[A-Za-z]+/g, '[^/]+')}$`));
  }

  test('every template link points to an existing frontend route', () => {
    const routes = knownRoutes();
    const bad = [];
    for (const [key, def] of Object.entries(DEFAULTS)) {
      const link = def.in_app && def.in_app.link;
      if (!link || /^\{\{\w+\}\}$/.test(link)) continue; // link given by the caller at send time
      const pathOnly = link.replace(/\{\{\w+\}\}/g, 'x').split('?')[0];
      if (!routes.some((rx) => rx.test(pathOnly))) bad.push(`${key}: ${link}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------- D

describe('[D][admin] RE-D-08 commission by lister, agent and city', () => {
  let other;
  beforeAll(async () => {
    other = await fx2.verifiedLister('owner', { name: 'Second Owner' });
    const pPune = await liveListing(w, lister);
    const pMumbai = await liveListing(w, other);
    await Property.updateOne({ _id: pMumbai._id }, { $set: { 'location.city': 'Mumbai' } });
    const mk = async (n, p, listerUser, agent, teamId, amount) => {
      const lead = await Lead.create({ leadNo: `L-D8-${n}-${Date.now()}`, buyer: { name: 'B', phone: `+9190000000${n}` }, propertyId: p._id, sources: ['enquiry'], teamId, assignedTo: agent });
      const d = await Deal.create({ dealNo: `D-D8-${n}-${Date.now()}`, leadId: lead._id, propertyId: p._id, agentId: agent, listerId: listerUser._id, teamId, dealType: 'sale', status: 'verified', commissionAmount: amount, gstAmount: amount * 0.18, review: { verifiedAt: new Date() } });
      await Receivable.create({ receivableNo: `R-D8-${n}-${Date.now()}`, dealId: d._id, listerId: listerUser._id, propertyId: p._id, agentId: agent, teamId, dealNo: d.dealNo, commissionAmount: amount, totalDue: amount * 1.18, status: 'pending_invoice' });
    };
    await mk(1, pPune, lister.user, agents[0].user._id, team._id, 100000);
    await mk(2, pMumbai, other.user, agents[1].user._id, new mongoose.Types.ObjectId(), 50000);
  });

  test('groupBy lister / agent / city; month stays the default; unknown groupBy is 422', async () => {
    const q = (g) => request(app).get(`/api/admin/reports/commission${g ? `?groupBy=${g}` : ''}`).set(A);
    const byLister = (await q('lister').expect(200)).body.data;
    expect(byLister.groupBy).toBe('lister');
    const l1 = byLister.rows.find((r) => r.listerId === String(lister.user._id));
    expect(l1).toMatchObject({ deals: 1, commission: 100000, outstanding: 118000 });
    expect(byLister.rows.find((r) => r.listerId === String(other.user._id)).lister).toBe('Second Owner');
    const byAgent = (await q('agent').expect(200)).body.data;
    expect(byAgent.rows.find((r) => r.agentId === String(agents[1].user._id))).toMatchObject({ commission: 50000 });
    const byCity = (await q('city').expect(200)).body.data;
    expect(byCity.rows.find((r) => r.city === 'Mumbai')).toMatchObject({ deals: 1, commission: 50000, outstanding: 59000 });
    expect(byCity.rows.find((r) => r.city === 'Pune').commission).toBeGreaterThanOrEqual(100000);
    expect((await q().expect(200)).body.data.rows[0]).toHaveProperty('month');
    expect((await q('banana')).status).toBe(422);
    const csv = await request(app).get('/api/admin/reports/commission/export?groupBy=city').set(A).expect(200);
    expect(csv.text.split('\n')[0]).toBe('city,deals,commission,gst,invoiced,received,tds,outstanding');
  });

  test('a manager sees only their teams; receivables filter by city', async () => {
    const mine = (await request(app).get('/api/admin/reports/commission?groupBy=city').set(M).expect(200)).body.data;
    expect(mine.rows.map((r) => r.city)).toEqual(['Pune']);
    const mumbai = await request(app).get('/api/admin/receivables?city=mumbai').set(A).expect(200);
    expect(mumbai.body.data.map((r) => r.dealNo)).toEqual([expect.stringMatching(/^D-D8-2-/)]);
  });
});

// ---------------------------------------------------------------- N

describe('[N][system] referral attribution and the MLM outbox', () => {
  test('?ref code -> referredBy at registration; a later code never changes it (lifetime attribution)', async () => {
    const buyer = await h.registerActive(app, 'buyer', { referralCode: 'refab12' });
    const u = await User.findById(buyer.userId);
    expect(u.referredBy).toBe('REFAB12');
    expect(u.referralCapturedAt).toBeTruthy();
    const r = await enquireOk(await liveListing(w, lister), { auth: h.bearer(buyer.accessToken), extra: { referralCode: 'OTHER999' } });
    expect((await Lead.findOne({ leadNo: r.body.data.leadNo })).referralCode).toBe('REFAB12');
    expect((await User.findById(buyer.userId)).referredBy).toBe('REFAB12');
  });

  test('RE-N-07: user.signup only when mlm.events lists it; opaque refs and the referral code, no PII', async () => {
    const off = await h.registerActive(app, 'buyer', { referralCode: 'NOEVT123' });
    await new Promise((r) => { setTimeout(r, 200); });
    expect(await outbox.Outbox.exists({ type: 'user.signup', aggregateId: off.userId })).toBeFalsy();

    await settings.set('mlm.events', ['deal.closed', 'deal.reversed', 'user.signup']);
    const on = await h.registerActive(app, 'lister', { referralCode: 'SIGNUP77' });
    const ev = await waitFor(() => outbox.Outbox.findOne({ type: 'user.signup', aggregateId: on.userId }).lean());
    expect(ev.payload).toMatchObject({ type: 'user.signup', platform: 'realestate', data: { userRef: `u_${on.userId}`, role: 'lister', listerType: 'owner', referralCode: 'SIGNUP77' } });
    const raw = JSON.stringify(ev.payload);
    for (const pii of [on.email, on.phoneE164, on.name, on.phone]) expect(raw).not.toContain(pii);
    await settings.set('mlm.events', ['deal.closed', 'deal.reversed']);
  });

  describe('dispatcher', () => {
    const saved = {};
    beforeAll(() => { Object.assign(saved, { url: env.MLM_ENGINE_URL, key: env.MLM_PLATFORM_KEY, secret: env.MLM_PLATFORM_SECRET }); Object.assign(env, { MLM_PLATFORM_KEY: 'pk_test', MLM_PLATFORM_SECRET: 'shh-secret' }); });
    afterAll(() => Object.assign(env, { MLM_ENGINE_URL: saved.url, MLM_PLATFORM_KEY: saved.key, MLM_PLATFORM_SECRET: saved.secret }));
    const only = async (doc) => outbox.Outbox.updateMany({ _id: { $ne: doc._id }, status: 'pending' }, { $set: { nextAttemptAt: new Date(Date.now() + 86400000) } });

    test('RE-N-04: the engine receives X-Platform-Key, X-Timestamp and an HMAC X-Signature over "ts.rawBody"', async () => {
      const got = [];
      const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { got.push({ url: req.url, headers: req.headers, raw }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
      });
      await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
      env.MLM_ENGINE_URL = `http://127.0.0.1:${server.address().port}/`;
      try {
        const doc = await outbox.record('user.signup', { userRef: 'u_test', referralCode: 'HMAC1234' });
        await only(doc);
        await outbox.dispatchDue({ enabled: true, sendUnreferred: false });
        expect(got).toHaveLength(1);
        const { headers, raw, url } = got[0];
        expect(url).toBe('/api/integrations/realestate/events');
        expect(headers['x-platform-key']).toBe('pk_test');
        expect(headers['x-signature']).toBe(hmacSha256('shh-secret', `${headers['x-timestamp']}.${raw}`));
        expect(Math.abs(Number(headers['x-timestamp']) - Date.now() / 1000)).toBeLessThan(30);
        expect(JSON.parse(raw).eventId).toBe(doc.eventId);
        expect(await outbox.Outbox.findById(doc._id).lean()).toMatchObject({ status: 'sent', attempts: 1, responseCode: 200 });
      } finally {
        await new Promise((r) => { server.close(r); });
      }
    });

    test('an unreachable engine keeps the event pending with backoff 1 min, then 5 min', async () => {
      const probe = http.createServer();
      await new Promise((r) => { probe.listen(0, '127.0.0.1', r); });
      const port = probe.address().port;
      await new Promise((r) => { probe.close(r); }); // nothing listens there now
      env.MLM_ENGINE_URL = `http://127.0.0.1:${port}`;
      const doc = await outbox.record('user.signup', { userRef: 'u_down', referralCode: 'DOWN1234' });
      await only(doc);
      const t0 = Date.now();
      await outbox.dispatchDue({ enabled: true });
      let e = await outbox.Outbox.findById(doc._id).lean();
      expect(e).toMatchObject({ status: 'pending', attempts: 1 });
      expect(e.lastError).toBeTruthy();
      expect(new Date(e.nextAttemptAt).getTime() - t0).toBeGreaterThanOrEqual(59 * 1000);
      expect(new Date(e.nextAttemptAt).getTime() - t0).toBeLessThan(2 * 60 * 1000);
      await outbox.Outbox.updateOne({ _id: doc._id }, { $set: { nextAttemptAt: new Date() } });
      const t1 = Date.now();
      await outbox.dispatchDue({ enabled: true });
      e = await outbox.Outbox.findById(doc._id).lean();
      expect(e.attempts).toBe(2);
      expect(new Date(e.nextAttemptAt).getTime() - t1).toBeGreaterThanOrEqual(4.9 * 60 * 1000);
      expect(e.attemptLog).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------- O, C, B

describe('[O][admin] acceptance 1: audit trail', () => {
  test('approving a listing writes an audit entry with the status before and after', async () => {
    const l = await fx2.verifiedLister('owner');
    const { id } = await fx2.fullListing(app, l, w);
    await request(app).post(`/api/lister/properties/${id}/submit`).set(l.t).expect(200);
    const res = await fx2.approve(app, admin.token, id);
    expect(res.body.data.status).toBe('live');
    const entry = await AuditLog.findOne({ action: 'listing.approve', entityId: id }).lean();
    expect(entry).toMatchObject({ actorId: admin.user._id, before: { status: 'pending_approval' }, after: { status: 'live' } });
    const api = await request(app).get(`/api/admin/audit-logs?entityId=${id}`).set(A).expect(200);
    expect(JSON.stringify(api.body.data)).toContain('listing.approve');
  });
});

describe('[C][agent] RE-C-02 manual lead capture', () => {
  test('hotline lead is created, assigned to the agent who logged it, audited; a duplicate on the property is 409', async () => {
    const p = await liveListing(w, lister);
    const AG = h.bearer(agents[0].token);
    const body = { source: 'hotline', name: 'Walk In Caller', phone: '+919811122233', propertyId: String(p._id), referralCode: 'HOT12345', consent: true, notes: 'Called the hotline' };
    const r = await request(app).post('/api/agent/leads').set(AG).send(body).expect(201);
    const lead = await Lead.findById(r.body.data._id || r.body.data.id || r.body.data.leadId) || await Lead.findOne({ 'buyer.phone': '+919811122233' });
    expect(lead).toMatchObject({ sources: ['hotline'], referralCode: 'HOT12345' });
    expect(String(lead.assignedTo)).toBe(String(agents[0].user._id));
    expect(lead.timeline[0].data).toMatchObject({ manual: true, type: 'hotline' });
    expect(await AuditLog.exists({ action: 'lead.manual', entityId: lead._id })).toBeTruthy();
    const dup = await request(app).post('/api/agent/leads').set(AG).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_LEAD');
    expect((await request(app).post('/api/agent/leads').set(AG).send({ ...body, consent: false })).status).toBe(422);
  });
});

describe('[B][system] RE-B-05 notification field masking', () => {
  test('the lister never sees buyer contact data and the buyer never sees lister data', async () => {
    const p = await liveListing(w, lister);
    const phone = newPhone();
    notify.sent.length = 0;
    const r = await enquireOk(p, { phone, extra: { name: 'Priya Buyer Sharma' } });
    const toLister = await Notification.find({ userId: lister.user._id, createdAt: { $gte: new Date(Date.now() - 60000) } }).lean();
    expect(toLister.length).toBeGreaterThan(0);
    const listerText = JSON.stringify(toLister);
    for (const secret of ['Priya', 'Sharma', phone, h.e164(phone)]) expect(listerText).not.toContain(secret);
    expect(listerText).toMatch(/Buyer \d+/);
    const toBuyer = notify.sent.filter((m) => m.to === h.e164(phone)).map((m) => m.text).join(' ');
    expect(toBuyer).toContain(r.body.data.leadNo);
    for (const secret of ['Rahul', 'Secret Owner', '9800000001', 'secret.owner@example.com']) expect(toBuyer).not.toContain(secret);
  });

  test('templates: lister-facing texts use no buyer placeholders, buyer-facing texts no lister placeholders', () => {
    const LISTER = ['lead.lister_new', 'sitevisit.lister_planned', 'sitevisit.lister_rescheduled', 'offer.received', 'offer.reminder', 'offer.buyer_responded', 'offer.expired', 'lister.update_shared', 'deal.verified_lister'];
    const BUYER = ['lead.created', 'lead.listings_shared', 'sitevisit.scheduled', 'sitevisit.rescheduled', 'sitevisit.reminder', 'sitevisit.feedback_request', 'deal.verified_buyer', 'whatsapp.share_listing', 'whatsapp.visit_confirmation'];
    const text = (k) => JSON.stringify(DEFAULTS[k]);
    for (const k of LISTER) expect([k, text(k).match(/\{\{(name|buyerName|buyerPhone|phone|email)\}\}/)]).toEqual([k, null]);
    for (const k of BUYER) expect([k, text(k).match(/\{\{(listerName|listerPhone|ownerName|ownerPhone|lister)\}\}/)]).toEqual([k, null]);
  });
});
