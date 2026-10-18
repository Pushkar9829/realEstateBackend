// Central Growth Hub lead sync (mlm-engine INTEGRATION_CONTRACT v1, section 6):
// enquiries become signed `lead.created` outbox events (canonical v1 envelope),
// stage changes `lead.updated`; never the lister's identity; nothing recorded
// while the hub integration is off; lead events are not skipped as "unreferred".
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const settings = require('../../src/core/settings');
const outbox = require('../../src/core/outbox');
const common = require('../../src/modules/leads/common');
const { Lead } = require('../../src/modules/leads/models');
const { Otp } = require('../../src/modules/auth/models');

let app; let w; let lister;
let seq = 0;
const newPhone = () => { seq += 1; return `97${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`; };

async function guestToken(phone) {
  await h.resetOtpLimits(h.e164(phone));
  await request(app).post('/api/leads/otp').send({ phone }).expect(200);
  const r = await request(app).post('/api/leads/otp/verify').send({ phone, code: h.otpFor(h.e164(phone)) }).expect(200);
  await Otp.deleteMany({ target: h.e164(phone) });
  return r.body.data.otpToken;
}

const leadEvents = (type) => outbox.Outbox.find({ type }).sort({ createdAt: -1 }).lean();

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  await settings.set('lead.maxEnquiriesPerIpPerHour', 1000);
});
afterAll(() => mongoose.disconnect());

describe('[S][system] Growth Hub lead sync', () => {
  test('hub integration off: an enquiry records no lead event', async () => {
    await settings.set('mlm.enabled', false);
    const p = await liveListing(w, lister);
    const before = (await leadEvents('lead.created')).length;
    const phone = newPhone();
    await request(app).post('/api/leads/enquiry').send({ type: 'enquiry', propertyId: String(p._id), name: 'Off Buyer', otpToken: await guestToken(phone), consent: true }).expect(201);
    expect((await leadEvents('lead.created')).length).toBe(before);
  });

  test('enquiry -> lead.created v1 envelope with the enquirer only; stage change -> lead.updated', async () => {
    await settings.set('mlm.enabled', true);
    const p = await liveListing(w, lister);
    const phone = newPhone();
    const r = await request(app).post('/api/leads/enquiry').send({ type: 'site_visit', propertyId: String(p._id), name: 'Hub Buyer', otpToken: await guestToken(phone), consent: true, whatsappOptIn: true }).expect(201);
    const [ev] = await leadEvents('lead.created');
    expect(ev.payload).toMatchObject({ type: 'lead.created', schemaVersion: '1', platform: 'realestate' });
    expect(ev.payload.data).toMatchObject({
      externalLeadId: r.body.data.leadNo,
      kind: 'site_visit_request',
      contact: { name: 'Hub Buyer', phone: h.e164(phone) },
      consent: { contact: true, whatsapp: true },
      subject: { type: 'property', id: p.listingNo, city: 'Pune' },
      requirement: { purpose: 'buy' },
    });
    const json = JSON.stringify(ev.payload);
    expect(json).not.toMatch(/lister|owner/i);
    expect(json).not.toContain(String(lister.user._id));

    const lead = await Lead.findOne({ leadNo: r.body.data.leadNo });
    await common.changeStage(lead, 'contacted', null, {});
    const [up] = await leadEvents('lead.updated');
    expect(up.payload.data).toMatchObject({ externalLeadId: lead.leadNo, platformStatus: 'contacted' });
  });

  test('contact form -> callback lead; lead events are delivered even without a referral code', async () => {
    await settings.set('mlm.enabled', true);
    const phone = newPhone();
    await request(app).post('/api/contact').send({ name: 'Form Person', phone, otpToken: await guestToken(phone), message: 'Please call me about Baner flats', consent: true, city: 'Pune' }).expect(201);
    const [ev] = await leadEvents('lead.created');
    expect(ev.payload.data).toMatchObject({ kind: 'callback', subject: { type: 'general', city: 'Pune' } });
    // With the engine URL unset the row stays pending for delivery; it is never skipped as unreferred.
    await outbox.dispatchDue({ enabled: true, sendUnreferred: false });
    expect((await outbox.Outbox.findById(ev._id)).status).toBe('pending');
  });
});
