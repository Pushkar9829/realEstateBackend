// Phase 1 (spec M1) - Module L CMS & Masters (+ public lookups used by every form).
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { Master, AgreementTemplate } = require('../../src/modules/cms/models');

let app; let admin; let staffNoPerm; let cityId;
beforeAll(async () => {
  app = await h.setup();
  admin = (await h.userWithToken('superadmin')).token;
  staffNoPerm = (await h.userWithToken('admin', { permissions: ['dashboard.view'] })).token;
});
afterAll(() => mongoose.disconnect());

const A = () => h.bearer(admin);

describe('[L][admin] RE-L-01/02 Cities and localities', () => {
  test('create a city; masters need masters.manage', async () => {
    const denied = await request(app).post('/api/admin/masters/cities').set(h.bearer(staffNoPerm)).send({ name: 'Pune' });
    expect(denied.body.error.code).toBe('MISSING_PERMISSION');
    const res = await request(app).post('/api/admin/masters/cities').set(A()).send({ name: 'Pune', state: 'Maharashtra', lat: 18.52, lng: 73.85 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'city', code: 'pune', slug: 'pune' });
    cityId = res.body.data._id;
  });

  test('a locality needs its city and a centroid; codes are unique and immutable', async () => {
    const noCity = await request(app).post('/api/admin/masters/localities').set(A()).send({ name: 'Baner', lat: 18.55, lng: 73.78 });
    expect(noCity.status).toBe(422);
    const ok = await request(app).post('/api/admin/masters/localities').set(A()).send({ name: 'Baner', parentId: cityId, lat: 18.55, lng: 73.78, pincodes: ['411045'] });
    expect(ok.body.data).toMatchObject({ code: 'baner', parentId: cityId });
    const dup = await request(app).post('/api/admin/masters/localities').set(A()).send({ name: 'Baner', parentId: cityId, lat: 18.55, lng: 73.78 });
    expect(dup.body.error.code).toBe('DUPLICATE');
    const edit = await request(app).patch(`/api/admin/masters/localities/${ok.body.data._id}`).set(A()).send({ name: 'Baner Gaon', code: 'changed' });
    expect(edit.body.data).toMatchObject({ name: 'Baner Gaon', code: 'baner' });
  });

  test('unknown master type -> 404; list and reorder', async () => {
    expect((await request(app).get('/api/admin/masters/planets').set(A())).body.error.code).toBe('UNKNOWN_MASTER');
    await request(app).post('/api/admin/masters/amenities').set(A()).send({ name: 'Gym' });
    await request(app).post('/api/admin/masters/amenities').set(A()).send({ name: 'Swimming Pool' });
    const list = await request(app).get('/api/admin/masters/amenities').set(A());
    const ids = list.body.data.map((x) => x._id).reverse();
    await request(app).patch('/api/admin/masters/amenities/reorder').set(A()).send({ ids }).expect(200);
    const after = await request(app).get('/api/admin/masters/amenities').set(A());
    expect(after.body.data.map((x) => x._id)).toEqual(ids);
  });

  test('CSV import creates and updates localities and reports bad rows', async () => {
    const csv = 'city,name,code,pincodes,lat,lng,aliases\npune,Wakad,,411057,18.59,73.76,Wakad Gaon\npune,Kharadi,,411014,18.55,73.94,\nnoida,Sector 62,,,28.6,77.3,\npune,Baner Gaon,baner,411045,18.56,73.79,';
    const res = await request(app).post('/api/admin/masters/localities/import').set(A()).send({ csv });
    expect(res.body.data).toMatchObject({ created: 2, updated: 1 });
    expect(res.body.data.errors[0]).toMatchObject({ line: 3, reason: expect.stringMatching(/Unknown city/) });
  });

  test('merge keeps the surviving locality with the old name as an alias', async () => {
    const wakad = await Master.findOne({ code: 'wakad' });
    const dupe = await request(app).post('/api/admin/masters/localities').set(A()).send({ name: 'Wakad Village', parentId: cityId, lat: 18.6, lng: 73.76 });
    const res = await request(app).post(`/api/admin/masters/localities/${dupe.body.data._id}/merge`).set(A()).send({ intoId: String(wakad._id) });
    expect(res.body.data.merged).toBe(true);
    expect((await Master.findById(wakad._id)).meta.aliases).toEqual(expect.arrayContaining(['Wakad Village', 'Wakad Gaon']));
    expect((await Master.findById(dupe.body.data._id)).active).toBe(false);
  });

  test('lister locality request: approve activates it', async () => {
    const reqd = await Master.create({ type: 'locality', code: 'balewadi', name: 'Balewadi', parentId: cityId, active: false, request: { status: 'pending' } });
    const res = await request(app).post(`/api/admin/masters/locality-requests/${reqd._id}/decision`).set(A()).send({ decision: 'approve' });
    expect(res.body.data).toMatchObject({ active: true, request: { status: 'approved' } });
    const again = await request(app).post(`/api/admin/masters/locality-requests/${reqd._id}/decision`).set(A()).send({ decision: 'reject' });
    expect(again.status).toBe(404);
  });
});

describe('[L][public] Public lookups', () => {
  test('active cities and localities by city code, with alias search', async () => {
    const cities = await request(app).get('/api/locations/cities');
    expect(cities.body.data.map((c) => c.code)).toContain('pune');
    const locs = await request(app).get('/api/locations/localities?city=pune');
    expect(locs.body.data.map((l) => l.code)).toEqual(expect.arrayContaining(['wakad', 'kharadi', 'balewadi']));
    expect(locs.body.data.map((l) => l.code)).not.toContain('wakad-village'); // merged away
    const alias = await request(app).get('/api/locations/localities?city=pune&q=gaon');
    expect(alias.body.data.map((l) => l.code)).toEqual(expect.arrayContaining(['wakad']));
    expect((await request(app).get('/api/locations/localities')).status).toBe(422);
  });

  test('public masters and public settings expose only safe values', async () => {
    await request(app).post('/api/admin/masters/property-types').set(A()).send({ name: 'Apartment', category: 'residential' });
    const m = await request(app).get('/api/masters/public');
    expect(m.body.data.propertyTypes[0]).toMatchObject({ code: 'apartment', meta: { category: 'residential' } });
    expect(m.body.data.amenities.length).toBeGreaterThanOrEqual(2);
    const s = await request(app).get('/api/settings/public');
    expect(s.body.data).toMatchObject({ hotline: expect.any(String), commission: { sale: { min: expect.any(Number) } } });
    expect(JSON.stringify(s.body.data)).not.toMatch(/gstin|password|secret/i);
  });
});

describe('[L][admin] RE-L-05/06/07 Pages, banners, FAQs, testimonials, home', () => {
  test('pages keep versions; only published pages are public', async () => {
    const p = await request(app).post('/api/admin/pages').set(A()).send({ slug: 'no-broker-policy', title: 'No-broker policy', content: 'v1' });
    expect((await request(app).get('/api/pages/no-broker-policy')).status).toBe(404);
    await request(app).patch(`/api/admin/pages/${p.body.data._id}`).set(A()).send({ content: 'v2', status: 'published' }).expect(200);
    const pub = await request(app).get('/api/pages/no-broker-policy');
    expect(pub.body.data.content).toBe('v2');
    const detail = await request(app).get(`/api/admin/pages/${p.body.data._id}`).set(A());
    expect(detail.body.data.versions[0]).toMatchObject({ version: 1, content: 'v1' });
  });

  test('banners, FAQs and testimonials CRUD with validation', async () => {
    const b = await request(app).post('/api/admin/banners').set(A()).send({ title: 'Diwali offers', imageUrl: 'https://example.com/b.jpg', cities: ['pune'] });
    expect(b.status).toBe(201);
    expect((await request(app).post('/api/admin/faqs').set(A()).send({ question: 'Is it free?', answer: 'Yes, for buyers.' })).status).toBe(201);
    expect((await request(app).post('/api/admin/faqs').set(A()).send({ question: 'x' })).status).toBe(422);
    expect((await request(app).post('/api/admin/testimonials').set(A()).send({ text: 'Found my flat in a week', rating: 5 })).status).toBe(201);
    expect((await request(app).get('/api/admin/banners').set(A())).body.data).toHaveLength(1);
  });

  test('home section order is a validated setting', async () => {
    const ok = await request(app).patch('/api/admin/home-sections').set(A()).send({ sections: ['search', 'projects', 'faqs'] });
    expect(ok.body.data.sections).toEqual(['search', 'projects', 'faqs']);
    expect((await request(app).patch('/api/admin/home-sections').set(A()).send({ sections: ['casino'] })).status).toBe(422);
  });

  test('sitemap lists published pages and city / locality landing pages', async () => {
    const res = await request(app).get('/api/sitemap.xml');
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toMatch(/\/p\/no-broker-policy/);
    expect(res.text).toMatch(/property-in-pune\/wakad/);
  });
});

describe('[L][admin] RE-L-08 Agreement templates', () => {
  const body = (clause) => `CHANNEL PARTNER AGREEMENT between {{listerName}} and {{companyName}} for {{propertyRef}} at {{commissionPercent}}% plus GST. ${clause} Accepted by {{acceptedName}} on {{acceptedAt}}. This text is long enough to be a real template body.`;

  test('publishing requires the non-circumvention clause', async () => {
    const t = await request(app).post('/api/admin/agreement-templates').set(A()).send({ purpose: 'sale', body: body('No other clause.') });
    expect(t.body.data).toMatchObject({ version: 1, status: 'draft' });
    const res = await request(app).post(`/api/admin/agreement-templates/${t.body.data._id}/publish`).set(A());
    expect(res.body.error.code).toBe('NON_CIRCUMVENTION_MISSING');
  });

  test('publishing a new version retires the previous one', async () => {
    const clause = 'Commission is payable if a platform buyer buys within {{nonCircumventionMonths}} months.';
    const v2 = await request(app).post('/api/admin/agreement-templates').set(A()).send({ purpose: 'sale', body: body(clause) });
    await request(app).post(`/api/admin/agreement-templates/${v2.body.data._id}/publish`).set(A()).expect(200);
    const v3 = await request(app).post('/api/admin/agreement-templates').set(A()).send({ purpose: 'sale', body: body(`${clause} Updated.`) });
    await request(app).post(`/api/admin/agreement-templates/${v3.body.data._id}/publish`).set(A()).expect(200);
    expect((await AgreementTemplate.findById(v2.body.data._id)).status).toBe('retired');
    expect((await AgreementTemplate.findById(v3.body.data._id))).toMatchObject({ version: 3, status: 'published' });
    const again = await request(app).post(`/api/admin/agreement-templates/${v3.body.data._id}/publish`).set(A());
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });
});
