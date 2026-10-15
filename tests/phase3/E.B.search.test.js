// Phase 3 (spec M3) - Module E Search & Discovery and Module B masking.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { liveListing, seedWorld } = require('./fixtures');
const { Master } = require('../../src/modules/cms/models');
const { Property } = require('../../src/modules/listings/models');
const { SavedSearch } = require('../../src/modules/search/models');
const search = require('../../src/modules/search/service');
const { Notification } = require('../../src/modules/notifications/models');
const { distanceM } = require('../../src/core/geo');

let app; let w; let lister; let buyer; let B;
beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  buyer = await h.userWithToken('buyer');
  B = h.bearer(buyer.token);
});
afterAll(() => mongoose.disconnect());

describe('[E][public] RE-E-01/02 Filtered search (acceptance 1, 6)', () => {
  test('Pune + sale + 2 BHK + max 90 L returns only matching live listings', async () => {
    const a = await liveListing(w, lister, { bhk: 2, amount: 8500000 });
    await liveListing(w, lister, { bhk: 3, amount: 8500000 });
    await liveListing(w, lister, { bhk: 2, amount: 9500000 });
    await liveListing(w, lister, { bhk: 2, amount: 8000000, purpose: 'rent' });
    await liveListing(w, lister, { bhk: 2, amount: 7000000, status: 'paused' });
    const r = await request(app).get('/api/properties').query({ city: 'pune', purpose: 'sale', bhk: '2', maxPrice: 9000000 }).expect(200);
    expect(r.body.data.every((c) => c.bhk === 2 && c.purpose === 'sale' && c.price.amount <= 900000000)).toBe(true);
    expect(r.body.data.map((c) => c.id)).toContain(String(a._id));
    expect(r.body.meta.facets.bhk.length).toBeGreaterThan(0);
  });

  test('sorts by price and newest; 4+ BHK filter; invalid sort is 422', async () => {
    await liveListing(w, lister, { bhk: 5, amount: 30000000 });
    const asc = await request(app).get('/api/properties').query({ purpose: 'sale', sort: 'price_asc' }).expect(200);
    const prices = asc.body.data.map((c) => c.price.amount);
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
    const big = await request(app).get('/api/properties').query({ purpose: 'sale', bhk: '4+' }).expect(200);
    expect(big.body.data.every((c) => c.bhk >= 4)).toBe(true);
    expect((await request(app).get('/api/properties').query({ sort: 'bogus' })).status).toBe(422);
  });

  test('verified=1 returns only photo/site verified listings; paused never appears', async () => {
    const v = await liveListing(w, lister, { verification: { photo: { status: 'verified', verifiedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) } } });
    await liveListing(w, lister, { verification: { photo: { status: 'verified', verifiedAt: new Date(), expiresAt: new Date(Date.now() - 86400000) } } }); // expired
    const r = await request(app).get('/api/properties').query({ verified: 1 }).expect(200);
    expect(r.body.data.map((c) => c.id)).toEqual([String(v._id)]);
    expect(r.body.data[0].badges.map((b) => b.code)).toContain('photo_verified');
    const all = await request(app).get('/api/properties').query({ limit: 50 }).expect(200);
    expect(all.body.data.some((c) => c.title.includes('number') && c.price.amount === 700000000)).toBe(false);
  });
});

describe('[E][public] RE-E-03/04 Map and near me (acceptance 2, 3)', () => {
  test('map pins are approximate (300-500 m from the exact pin), stable, and capped at 500', async () => {
    const p = await liveListing(w, lister, { lat: 18.60, lng: 73.80 });
    const box = { swLat: 18.5, swLng: 73.7, neLat: 18.7, neLng: 73.9 };
    const a = await request(app).get('/api/properties/map').query(box).expect(200);
    const b = await request(app).get('/api/properties/map').query(box).expect(200);
    const pin = a.body.data.pins.find((x) => x.id === String(p._id));
    const d = distanceM({ type: 'Point', coordinates: [pin.point.lng, pin.point.lat] }, p.location.geo);
    expect(d).toBeGreaterThanOrEqual(299);
    expect(d).toBeLessThanOrEqual(501);
    expect(b.body.data.pins.find((x) => x.id === String(p._id)).point).toEqual(pin.point);
    expect(a.body.data.pins.length).toBeLessThanOrEqual(500);
  });

  test('near me returns listings within the radius sorted by distance', async () => {
    const r = await request(app).get('/api/properties/near').query({ lat: 18.56, lng: 73.79, radiusKm: 5 }).expect(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    const dist = r.body.data.map((c) => c.distanceKm);
    expect(dist).toEqual([...dist].sort((x, y) => x - y));
    expect(dist.every((x) => x <= 5.5)).toBe(true);
  });
});

describe('[B][public] RE-B-01/03/11 No lister data in any public response (acceptance B1)', () => {
  test('detail, search, map, near, similar and compare contain no lister phone, email, name, unit or address', async () => {
    const p = await liveListing(w, lister);
    const responses = await Promise.all([
      request(app).get(`/api/properties/${p.slug}`),
      request(app).get('/api/properties').query({ limit: 50 }),
      request(app).get('/api/properties/map').query({ swLat: 18, swLng: 73, neLat: 19, neLng: 74 }),
      request(app).get('/api/properties/near').query({ lat: 18.56, lng: 73.79 }),
      request(app).get(`/api/properties/${p._id}/similar`),
      request(app).get('/api/compare').query({ ids: String(p._id) }),
      request(app).get('/api/home'),
    ]);
    for (const r of responses) {
      expect(r.status).toBe(200);
      const body = JSON.stringify(r.body);
      for (const secret of ['9800000001', 'secret.owner@example.com', 'Rahul Secret Owner', 'Flat 504', `U-${p.location.unitNo.slice(2)}`, String(lister.user._id)]) expect(body).not.toContain(secret);
      expect(body).not.toMatch(/addressLine|unitNo|listerId|ownershipProofs|commission/);
    }
    const detail = responses[0].body.data;
    expect(detail.listerBadge).toBe('Verified Owner');
    expect(detail.badges[0]).toMatchObject({ code: 'verified_lister' });
    expect(detail.badges[0].tooltip.length).toBeGreaterThan(10);
    expect(detail.hotline).toBeTruthy();
  });

  test('/properties/map is not swallowed by the masked-detail route', async () => {
    const r = await request(app).get('/api/properties/map').query({ swLat: 18, swLng: 73, neLat: 19, neLng: 74 });
    expect(r.body.data).toHaveProperty('pins');
  });

  test('WhatsApp click returns the platform number, never the lister', async () => {
    await require('../../src/core/settings').set('general.whatsappNumber', '+91 90000 11111');
    const p = await liveListing(w, lister);
    const r = await request(app).post(`/api/properties/${p._id}/whatsapp-click`).expect(200);
    expect(r.body.data.url).toMatch(/^https:\/\/wa\.me\/919000011111\?text=.*RE\d{2}-/);
    expect(r.body.data.url).not.toContain('9800000001');
  });
});

describe('[E][public] RE-E-07/08/09 Shortlist, saved searches and alerts (acceptance 4, 5)', () => {
  test('shortlist add / list / remove', async () => {
    const p = await liveListing(w, lister);
    await request(app).post('/api/me/shortlist').set(B).send({ propertyId: String(p._id) }).expect(200);
    const list = await request(app).get('/api/me/shortlist').set(B).expect(200);
    expect(list.body.data[0]).toMatchObject({ id: String(p._id), available: true });
    await request(app).delete(`/api/me/shortlist/${p._id}`).set(B).expect(200);
    expect((await request(app).get('/api/me/shortlist').set(B)).body.data).toHaveLength(0);
  });

  test('an 11th saved search is 422', async () => {
    const u = await h.userWithToken('buyer');
    for (let i = 0; i < 10; i += 1) await request(app).post('/api/me/saved-searches').set(h.bearer(u.token)).send({ name: `Search ${i}`, filters: { city: 'pune', purpose: 'sale' } }).expect(201);
    expect((await request(app).post('/api/me/saved-searches').set(h.bearer(u.token)).send({ name: 'Eleven', filters: {} })).status).toBe(422);
  });

  test('a newly live listing matching an instant search produces one alert', async () => {
    const u = await h.userWithToken('buyer');
    await request(app).post('/api/me/saved-searches').set(h.bearer(u.token)).send({ name: '3 BHK Baner', filters: { city: 'pune', purpose: 'sale', bhk: '3' }, frequency: 'instant' }).expect(201);
    const p = await liveListing(w, lister, { bhk: 3 });
    const sent = await search.alertInstant(p._id);
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(await Notification.countDocuments({ userId: u.user._id, eventKey: 'alert.instant' })).toBe(1);
    const other = await liveListing(w, lister, { bhk: 1 });
    await search.alertInstant(other._id);
    expect(await Notification.countDocuments({ userId: u.user._id, eventKey: 'alert.instant' })).toBe(1);
  });

  test('unsubscribe link turns alerts off', async () => {
    const s = await SavedSearch.findOne({ frequency: 'instant' });
    const r = await request(app).get(`/api/alerts/unsubscribe/${search.unsubscribeToken(s._id)}`).expect(200);
    expect(r.body.data.frequency).toBe('off');
    expect((await request(app).get(`/api/alerts/unsubscribe/${s._id}.forged`)).status).toBe(400);
  });
});

describe('[E][public] RE-E-11/17 Landing pages and trends (acceptance 7)', () => {
  test('a locality with 4 live sale listings shows no average; with 5 it does', async () => {
    const kothrud = await Master.create({ type: 'locality', code: 'kothrud-test', name: 'Kothrud Test', slug: 'kothrud-test', parentId: w.city._id, meta: { centroid: { type: 'Point', coordinates: [73.81, 18.50] } } });
    for (let i = 0; i < 4; i += 1) await liveListing(w, lister, { locality: kothrud, localityName: 'Kothrud Test', lat: 18.50, lng: 73.81 });
    const four = await request(app).get('/api/locations/pune/kothrud-test/summary').expect(200);
    expect(four.body.data.stats.sale.avgPricePerSqft).toBeNull();
    await liveListing(w, lister, { locality: kothrud, localityName: 'Kothrud Test', lat: 18.50, lng: 73.81 });
    const five = await request(app).get('/api/locations/pune/kothrud-test/summary').expect(200);
    expect(five.body.data.stats.sale.avgPricePerSqft).toBeGreaterThan(0);
    const t = await search.computeTrends();
    expect(t.written).toBeGreaterThan(0);
    const tr = await request(app).get('/api/locations/pune/kothrud-test/trends').expect(200);
    expect(tr.body.data.sale.length).toBe(1);
  });

  test('city summary and localities index', async () => {
    const r = await request(app).get('/api/locations/pune/summary').expect(200);
    expect(r.body.data.city.name).toBe('Pune');
    expect(r.body.data.stats.sale.listings).toBeGreaterThan(0);
    const idx = await request(app).get('/api/locations/pune/localities/trends').expect(200);
    expect(idx.body.data.find((l) => l.code === 'baner').saleListings).toBeGreaterThan(0);
  });
});

describe('[E][public] RE-E-19 Sentence parser (acceptance 9)', () => {
  test('"2 bhk under 60 lakh in Baner" -> sale, 2 BHK, max 6000000, Baner', async () => {
    const r = await request(app).get('/api/search/parse').query({ q: '2 bhk under 60 lakh in Baner', city: 'pune' }).expect(200);
    expect(r.body.data.filters).toMatchObject({ purpose: 'sale', bhk: '2', maxPrice: 6000000, localities: 'baner' });
  });
  test('rent sentence and furnishing', async () => {
    const r = await request(app).get('/api/search/parse').query({ q: 'furnished 1 bhk flat for rent under 25k' }).expect(200);
    expect(r.body.data.filters).toMatchObject({ purpose: 'rent', bhk: '1', maxPrice: 25000, furnishing: 'full', types: 'apartment' });
  });
});

describe('[E][admin] RE-E-13/14 Views, compare, reports', () => {
  test('one view per session per day; bots ignored', async () => {
    const p = await liveListing(w, lister);
    await request(app).post(`/api/properties/${p._id}/view`).set('x-session-id', 's1').expect(200);
    await request(app).post(`/api/properties/${p._id}/view`).set('x-session-id', 's1').expect(200);
    await request(app).post(`/api/properties/${p._id}/view`).set('x-session-id', 's2').expect(200);
    await request(app).post(`/api/properties/${p._id}/view`).set('user-agent', 'Googlebot/2.1').expect(200);
    expect((await Property.findById(p._id)).stats.views).toBe(2);
  });

  test('compare drops offline listings', async () => {
    const a = await liveListing(w, lister);
    const b = await liveListing(w, lister, { status: 'paused' });
    const r = await request(app).get('/api/compare').query({ ids: `${a._id},${b._id}` }).expect(200);
    expect(r.body.data.items).toHaveLength(1);
    expect(r.body.data.dropped).toEqual([String(b._id)]);
  });

  test('report a listing; admin pauses it; lister is notified', async () => {
    const p = await liveListing(w, lister);
    const rep = await request(app).post(`/api/properties/${p._id}/report`).send({ reason: 'already_sold', details: 'Sold last week' }).expect(201);
    expect(rep.body.data.reportNo).toMatch(/^LR\d{2}-/);
    const admin = await h.userWithToken('superadmin');
    const A = h.bearer(admin.token);
    const list = await request(app).get('/api/admin/listing-reports').set(A).expect(200);
    const row = list.body.data.find((x) => x.propertyId._id === String(p._id));
    await request(app).patch(`/api/admin/listing-reports/${row._id}`).set(A).send({ action: 'pause', note: 'Owner says sold' }).expect(200);
    expect((await Property.findById(p._id)).status).toBe('paused');
    expect(await Notification.exists({ userId: lister.user._id, eventKey: 'listing.report_actioned' })).toBeTruthy();
  });

  test('autocomplete finds localities and cities', async () => {
    const r = await request(app).get('/api/properties/autocomplete').query({ q: 'Ban' }).expect(200);
    expect(r.body.data.some((x) => x.kind === 'locality' && x.value === 'baner')).toBe(true);
  });
});
