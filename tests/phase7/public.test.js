// Phase 7 - public site gaps: unavailable listings (RE-S-PUB-04 states), the
// RERA QR code endpoint (RE-G-08) and the public settings used by the footer,
// cookie banner and referral capture (RE-L-10, RE-L-11, RE-M-10, RE-N-01).
const request = require('supertest');
const mongoose = require('mongoose');
const { liveListing, seedWorld, h } = require('../phase3/fixtures');
const { Master } = require('../../src/modules/cms/models');
const { Property } = require('../../src/modules/listings/models');
const settings = require('../../src/core/settings');

let app; let w; let lister;
beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
});
afterAll(() => mongoose.disconnect());

const SECRETS = ['9800000001', 'secret.owner@example.com', 'Rahul Secret Owner', 'Flat 504', 'Green Park Society'];

describe('[E][B][public] RE-S-PUB-04 sold, rented, expired and paused listings', () => {
  test('a sold listing is 410 LISTING_UNAVAILABLE with a minimal safe payload and similar live listings in the same locality and purpose', async () => {
    const sold = await liveListing(w, lister, { status: 'sold' });
    const same = await liveListing(w, lister);
    const rent = await liveListing(w, lister, { purpose: 'rent', amount: 30000 });
    const aundh = await Master.findOneAndUpdate({ type: 'locality', code: 'aundh' }, { $setOnInsert: { type: 'locality', code: 'aundh', name: 'Aundh', slug: 'aundh', parentId: w.city._id } }, { upsert: true, new: true });
    const elsewhere = await liveListing(w, lister, { locality: aundh, localityName: 'Aundh' });
    const r = await request(app).get(`/api/properties/${sold.slug}`).expect(410);
    expect(r.body.success).toBe(false);
    expect(r.body.error.code).toBe('LISTING_UNAVAILABLE');
    const d = r.body.error.details;
    expect(d).toMatchObject({ title: sold.title, listingNo: sold.listingNo, city: 'Pune', locality: 'Baner', status: 'sold', temporary: false });
    const ids = d.similar.map((c) => c.id);
    expect(ids).toContain(String(same._id));
    expect(ids).not.toContain(String(sold._id));
    expect(ids).not.toContain(String(rent._id));
    expect(ids).not.toContain(String(elsewhere._id));
    expect(d.similar.length).toBeLessThanOrEqual(6);
    expect(d).not.toHaveProperty('price');
    expect(d).not.toHaveProperty('media');
    const body = JSON.stringify(r.body);
    for (const s of SECRETS) expect(body).not.toContain(s);
    expect(body).not.toMatch(/addressLine|unitNo|listerId|ownershipProofs|commission|"geo"/);
    expect(body).not.toContain(String(lister.user._id));
  });

  test('rented maps to rented; expired and inactive map to unavailable; paused is temporary', async () => {
    const cases = [['rented', 'rented', false], ['expired', 'unavailable', false], ['inactive', 'unavailable', false], ['paused', 'unavailable', true]];
    for (const [status, mapped, temporary] of cases) {
      const p = await liveListing(w, lister, { status, purpose: status === 'rented' ? 'rent' : 'sale', amount: status === 'rented' ? 25000 : 8500000 });
      const r = await request(app).get(`/api/properties/${p.slug}`).expect(410);
      expect(r.body.error.details).toMatchObject({ status: mapped, temporary });
    }
  });

  test('slugs that never existed, deleted, draft, pending and suspended listings stay 404', async () => {
    expect((await request(app).get('/api/properties/never-existed-slug').expect(404)).body.error.code).toBe('NOT_FOUND');
    const deleted = await liveListing(w, lister, { status: 'sold' });
    await Property.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });
    await request(app).get(`/api/properties/${deleted.slug}`).expect(404);
    for (const status of ['draft', 'pending_approval', 'suspended', 'rejected']) {
      const p = await liveListing(w, lister, { status });
      await request(app).get(`/api/properties/${p.slug}`).expect(404);
    }
    const sold = await liveListing(w, lister, { status: 'sold' });
    await request(app).get(`/api/properties/${sold._id}`).expect(404); // id lookups never leak the gone payload
  });

  test('live listings still return the masked detail', async () => {
    const p = await liveListing(w, lister);
    const r = await request(app).get(`/api/properties/${p.slug}`).expect(200);
    expect(r.body.data).toMatchObject({ id: String(p._id), listingNo: p.listingNo });
  });
});

describe('[G][public] RE-G-08 RERA QR code', () => {
  test('returns a cacheable PNG for an https URL on an allowed RERA host', async () => {
    const r = await request(app).get('/api/rera/qr').query({ url: 'https://maharera.maharashtra.gov.in/projects/P52100012345' }).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(r.body.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  test('rejects missing, non-https, credentialed and non-allowed hosts with 400', async () => {
    const bad = [undefined, 'not a url', 'http://maharera.maharashtra.gov.in/x', 'https://evil.example.com/x', 'https://maharera.maharashtra.gov.in.evil.com/x', 'https://user:pw@maharera.maharashtra.gov.in/x', 'javascript:alert(1)'];
    for (const url of bad) {
      const r = await request(app).get('/api/rera/qr').query(url === undefined ? {} : { url });
      expect(r.status).toBe(400);
      expect(r.body.success).toBe(false);
    }
  });

  test('with an empty host list any *.gov.in host is allowed', async () => {
    const before = await settings.get('rera.urlHosts');
    await settings.set('rera.urlHosts', []);
    try {
      await request(app).get('/api/rera/qr').query({ url: 'https://rera.karnataka.gov.in/project/1' }).expect(200);
      expect((await request(app).get('/api/rera/qr').query({ url: 'https://rera.example.org/project/1' })).status).toBe(400);
      expect((await request(app).get('/api/rera/qr').query({ url: 'https://notgov.in/x' })).status).toBe(400);
    } finally {
      await settings.set('rera.urlHosts', before);
    }
  });
});

describe('[B][public] public settings used by the footer, cookie banner and referral capture', () => {
  test('exposes consent, RERA, grievance officer, WhatsApp, helpdesk and the referral window', async () => {
    const r = await request(app).get('/api/settings/public').expect(200);
    const d = r.body.data;
    expect(d.consent).toMatchObject({ bannerEnabled: true, cookieDays: 180 });
    expect(d.rera).toHaveProperty('agentRegistrations');
    expect(d.rera).toHaveProperty('showQr');
    expect(d.privacy).toHaveProperty('grievanceOfficer');
    expect(d).toHaveProperty('whatsappNumber');
    expect(d).toHaveProperty('helpdeskUrl');
    expect(d.referral).toEqual({ captureDays: 30 });
  });
});
