// Audit fixes (docs/audit/realestate.md, 2026-10-18): brochure download on the
// public pages (RE-A-07), small-count masking of the lister stats funnel driven
// by stats.smallCountMasking, masked-call availability on the agent lead (A4),
// and the ExportJob / UnitImport indexes.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { liveListing, seedWorld } = require('../phase3/fixtures');
const { Lead } = require('../../src/modules/leads/models');
const { Property } = require('../../src/modules/listings/models');
const { ExportJob } = require('../../src/modules/reports/models');
const { UnitImport } = require('../../src/modules/projects/models');
const { signGuest } = require('../../src/core/security/jwt');
const counters = require('../../src/core/counters');
const settings = require('../../src/core/settings');

let app; let w; let lister;
const GUEST = '+919811122233';

beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
});
afterAll(() => mongoose.disconnect());

async function lead(p, over = {}) {
  return Lead.create({
    leadNo: await counters.leadNo(), buyer: { name: 'Guest Buyer', phone: GUEST }, propertyId: p._id, stage: 'new', sources: ['enquiry'], requirement: { city: 'Pune' }, ...over,
  });
}

describe('[A][public] RE-A-07 brochure download', () => {
  let p;
  beforeAll(async () => {
    p = await liveListing(w, lister);
    await Property.updateOne({ _id: p._id }, { $set: { 'media.brochure': { url: 'http://files.test/brochure.pdf' } } });
  });
  afterEach(async () => { await settings.set('public.brochureGated', true); settings.clearCache(); });

  test('gated: a visitor without an enquiry is asked to enquire; the verified guest who enquired gets the file', async () => {
    const url = `/api/properties/${p.slug}/brochure`;
    const anon = await request(app).get(url);
    expect(anon.status).toBe(403);
    expect(anon.body.error.code).toBe('ENQUIRE_FIRST');
    // a guest token for a phone with no lead on this listing is not enough
    expect((await request(app).get(url).set('X-Guest-Token', signGuest('+919800055555'))).status).toBe(403);
    expect((await request(app).get(url).set('X-Guest-Token', 'not-a-token')).status).toBe(403);
    await lead(p);
    const ok = await request(app).get(url).set('X-Guest-Token', signGuest(GUEST)).expect(200);
    expect(ok.body.data.url).toBe('http://files.test/brochure.pdf');
  });

  test('a signed-in buyer with a lead gets it; with gating off anyone does; no brochure is 404', async () => {
    const q = await liveListing(w, lister);
    await Property.updateOne({ _id: q._id }, { $set: { 'media.brochure': { url: 'http://files.test/b2.pdf' } } });
    const buyer = await h.userWithToken('buyer');
    const url = `/api/properties/${q.slug}/brochure`;
    expect((await request(app).get(url).set(h.bearer(buyer.token))).status).toBe(403);
    await lead(q, { buyer: { name: 'Signed In', phone: buyer.user.phone, userId: buyer.user._id } });
    expect((await request(app).get(url).set(h.bearer(buyer.token))).status).toBe(200);
    await settings.set('public.brochureGated', false);
    settings.clearCache();
    expect((await request(app).get(url)).status).toBe(200);
    const none = await liveListing(w, lister);
    expect((await request(app).get(`/api/properties/${none.slug}/brochure`)).status).toBe(404);
  });
});

describe('[O][lister] stats funnel masking follows stats.smallCountMasking', () => {
  afterAll(async () => { await settings.set('stats.smallCountMasking', true); settings.clearCache(); });

  test('one lead shows as "<3" while masking is on and as 1 when it is off', async () => {
    const p = await liveListing(w, lister);
    await Lead.create({ leadNo: await counters.leadNo(), buyer: { name: 'One', phone: '+919811100001' }, propertyId: p._id, stage: 'new', sources: ['enquiry'] });
    const url = `/api/lister/properties/${p._id}/stats`;
    const masked = await request(app).get(url).set(lister.t).expect(200);
    expect(masked.body.data.funnel.find((f) => f.stage === 'new').count).toBe('<3');
    expect(masked.body.data.funnel.find((f) => f.stage === 'contacted').count).toBe(0);
    await settings.set('stats.smallCountMasking', false);
    settings.clearCache();
    const exact = await request(app).get(url).set(lister.t).expect(200);
    expect(exact.body.data.funnel.find((f) => f.stage === 'new').count).toBe(1);
  });
});

describe('[C][agent] A4 masked call only with a telephony provider', () => {
  test('lead detail says maskedCallAvailable = false without a provider', async () => {
    const p = await liveListing(w, lister);
    const agent = await h.userWithToken('agent');
    const l = await Lead.create({ leadNo: await counters.leadNo(), buyer: { name: 'Call Me', phone: '+919811100002' }, propertyId: p._id, stage: 'contacted', sources: ['enquiry'], assignedTo: agent.user._id });
    const r = await request(app).get(`/api/agent/leads/${l._id}`).set(h.bearer(agent.token)).expect(200);
    expect(r.body.data.maskedCallAvailable).toBe(false);
  });
});

describe('[Infra] indexes added by the audit', () => {
  test('ExportJob purges expired jobs (TTL) and UnitImport is indexed by project', async () => {
    const ej = await ExportJob.collection.indexes();
    const ttl = ej.find((i) => i.key.expiresAt === 1 && i.expireAfterSeconds != null);
    expect(ttl).toBeTruthy();
    expect(ttl.expireAfterSeconds).toBe(30 * 24 * 3600);
    const ui = await UnitImport.collection.indexes();
    expect(ui.some((i) => i.key.projectId === 1)).toBe(true);
    expect(ui.some((i) => i.key.createdAt === 1 && i.expireAfterSeconds != null && i.partialFilterExpression)).toBe(true);
  });
});

describe('[L][public] P8 lister-faq page for "List your property"', () => {
  test('ships as a default content page (seeded, published) with question / answer blocks', () => {
    const pages = require('../../scripts/default-content-pages');
    const faq = pages.find((p) => p.slug === 'lister-faq');
    expect(faq).toBeTruthy();
    const blocks = faq.content.split(/\n{2,}/).map((b) => b.split('\n'));
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    blocks.forEach((b) => { expect(b[0]).toMatch(/\?$/); expect(b.slice(1).join(' ').length).toBeGreaterThan(20); });
  });
});
