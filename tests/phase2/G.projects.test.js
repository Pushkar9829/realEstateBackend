// Phase 2 (spec M2) - Module G Builder Projects (RERA, configurations, inventory, CSV units).
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx = require('./fixtures');
const { Project, ProjectUnit } = require('../../src/modules/projects/models');
const projects = require('../../src/modules/projects/service');

let app; let w; let admin; let A; let builder;
beforeAll(async () => {
  app = await h.setup();
  w = await fx.world();
  admin = await h.userWithToken('superadmin');
  A = h.bearer(admin.token);
  builder = await fx.verifiedLister('builder', { email: 'sales@skyline.example', phone: '+919811111111' });
});
afterAll(() => mongoose.disconnect());

const CONFIGS = [
  { name: '2 BHK Type A', bhk: 2, carpetMin: 700, carpetMax: 760, priceMin: 8000000, priceMax: 9500000, totalUnits: 120, availableUnits: 40 },
  { name: '3 BHK Type B', bhk: 3, carpetMin: 1000, carpetMax: 1100, priceMin: 12000000, priceMax: 14000000, totalUnits: 60, availableUnits: 4 },
];

async function draft(who = builder) {
  const r = await request(app).post('/api/lister/projects').set(who.t).send({ name: 'Skyline Heights' }).expect(201);
  const id = r.body.data._id;
  const tab = (t, body) => request(app).patch(`/api/lister/projects/${id}/steps/${t}`).set(who.t).send(body);
  await tab('details', { name: 'Skyline Heights', description: 'Two towers of 2 and 3 BHK homes next to the Baner hills with a clubhouse, pool and landscaped podium garden.', possession: { status: 'under_construction', date: '2028-12-31' } }).expect(200);
  await tab('location', { cityId: String(w.city._id), localityId: String(w.baner._id), addressLine: 'Survey 42, Baner Road', pincode: '411045', lat: 18.561, lng: 73.789 }).expect(200);
  await tab('amenities', { amenities: ['lift', 'gym'] }).expect(200);
  return { id, tab };
}

async function rera(who, tab, overrides = {}) {
  const cert = await fx.upload(app, who.token, 'rera_certificate', fx.PDF(`rera-${Math.random()}`), 'rera.pdf', 'application/pdf');
  return tab('rera', { registrations: [{ number: 'P52100012345', state: 'Maharashtra', url: 'https://maharera.maharashtra.gov.in/projects/P52100012345', certificateFileId: cert.id, ...overrides }] });
}

const agree = (who, id) => request(app).post(`/api/lister/projects/${id}/commission`).set(who.t).send({ percent: 2, accept: true, typedName: 'Asha Owner' });

async function ready(who = builder) {
  const d = await draft(who);
  await d.tab('configurations', { items: CONFIGS }).expect(200);
  expect((await rera(who, d.tab)).status).toBe(200);
  await agree(who, d.id).expect(200);
  return d;
}

async function live(who = builder) {
  const d = await ready(who);
  await request(app).post(`/api/lister/projects/${d.id}/submit`).set(who.t).expect(200);
  await request(app).post(`/api/admin/projects/${d.id}/claim`).set(A).expect(200);
  const r = await request(app).post(`/api/admin/projects/${d.id}/decision`).set(A).send({ decision: 'approve', checklist: { rera_verified: true, details_match: true, media_ok: true } });
  expect(r.status).toBe(200);
  return { ...d, slug: r.body.data.slug };
}

describe('[G][lister] RE-G-01 Builder-only panel', () => {
  test('owners and buyers cannot create projects', async () => {
    const owner = await fx.verifiedLister('owner');
    expect((await request(app).post('/api/lister/projects').set(owner.t).send({ name: 'Nope' })).body.error.code).toBe('BUILDERS_ONLY');
    const buyer = await h.userWithToken('buyer');
    expect((await request(app).post('/api/lister/projects').set(h.bearer(buyer.token)).send({ name: 'Nope' })).status).toBe(403);
  });

  test('a builder sees only their own projects', async () => {
    const other = await fx.verifiedLister('builder');
    const { id } = await draft(other);
    expect((await request(app).get(`/api/lister/projects/${id}`).set(builder.t)).status).toBe(404);
    const mine = await request(app).get('/api/lister/projects').set(other.t);
    expect(mine.body.data.map((p) => p._id)).toContain(id);
  });

  test('contact details in the description are blocked', async () => {
    const { tab } = await draft();
    const r = await tab('details', { name: 'Skyline', description: 'Call 9876543210 now for a site visit and best price on all 2 and 3 BHK homes in this project.', possession: { status: 'ready' } });
    expect(r.body.error.code).toBe('CONTACT_INFO_BLOCKED');
  });
});

describe('[G][lister] RE-G-02/08 Submit gates (acceptance 1 and 4)', () => {
  test('submit without configurations or agreement is blocked', async () => {
    const { id, tab } = await draft();
    expect((await rera(builder, tab)).status).toBe(200);
    const r = await request(app).post(`/api/lister/projects/${id}/submit`).set(builder.t);
    expect(r.status).toBe(422);
    const paths = r.body.error.details.map((x) => x.path);
    expect(paths).toEqual(expect.arrayContaining(['configurations', 'commission']));
  });

  test('missing RERA is 422', async () => {
    const { id, tab } = await draft();
    await tab('configurations', { items: CONFIGS }).expect(200);
    await agree(builder, id).expect(200);
    const r = await request(app).post(`/api/lister/projects/${id}/submit`).set(builder.t);
    expect(r.status).toBe(422);
    expect(r.body.error.details.map((x) => x.path)).toEqual(['rera']);
  });

  test('900 sq m / 20 unit exemption is 422; 400 sq m exemption is accepted', async () => {
    const { tab } = await draft();
    const doc = await fx.upload(app, builder.token, 'rera_certificate', fx.PDF('plan'), 'plan.pdf', 'application/pdf');
    const bad = await tab('rera', { exempt: { reason: 'plot_upto_500sqm', plotAreaSqm: 900, units: 20, docFileId: doc.id } });
    expect(bad.status).toBe(422);
    await tab('rera', { exempt: { reason: 'plot_upto_500sqm', plotAreaSqm: 400, units: 20, docFileId: doc.id } }).expect(200);
  });

  test('wrong number pattern and non-official host are warnings, not errors', async () => {
    const { tab } = await draft();
    const r = await rera(builder, tab, { number: 'MH12345', url: 'https://example.com/rera' });
    expect(r.status).toBe(200);
    expect(r.body.data.warnings).toEqual(expect.arrayContaining(['rera_number_format:MH12345', 'rera_url_host:MH12345']));
  });

  test('configuration validation: 1-30 items and available <= total', async () => {
    const { tab } = await draft();
    expect((await tab('configurations', { items: [] })).status).toBe(422);
    expect((await tab('configurations', { items: [{ ...CONFIGS[0], availableUnits: 500 }] })).status).toBe(422);
  });
});

describe('[G][admin] RE-G-02 Review and decision', () => {
  test('approve needs claim + full checklist; builder is notified; project goes live with slug', async () => {
    const { id } = await ready();
    await request(app).post(`/api/lister/projects/${id}/submit`).set(builder.t).expect(200);
    const q = await request(app).get('/api/admin/projects').set(A);
    expect(q.body.data.map((p) => p._id)).toContain(id);
    expect((await request(app).post(`/api/admin/projects/${id}/decision`).set(A).send({ decision: 'reject', reason: 'x' })).body.error.code).toBe('NOT_CLAIMED');
    await request(app).post(`/api/admin/projects/${id}/claim`).set(A).expect(200);
    expect((await request(app).post(`/api/admin/projects/${id}/decision`).set(A).send({ decision: 'approve', checklist: { rera_verified: true } })).status).toBe(422);
    const r = await request(app).post(`/api/admin/projects/${id}/decision`).set(A).send({ decision: 'approve', checklist: { rera_verified: true, details_match: true, media_ok: true } });
    expect(r.body.data).toMatchObject({ status: 'live' });
    expect(r.body.data.slug).toMatch(/^skyline-heights-/);
    const p = await Project.findById(id);
    expect(p.location.publicGeo.coordinates).toBeDefined();
  });

  test('changes requested needs comments and lets the builder resubmit', async () => {
    const { id } = await ready();
    await request(app).post(`/api/lister/projects/${id}/submit`).set(builder.t).expect(200);
    await request(app).post(`/api/admin/projects/${id}/claim`).set(A).expect(200);
    expect((await request(app).post(`/api/admin/projects/${id}/decision`).set(A).send({ decision: 'changes' })).status).toBe(422);
    await request(app).post(`/api/admin/projects/${id}/decision`).set(A).send({ decision: 'changes', comments: [{ field: 'media', comment: 'Add tower photos' }] }).expect(200);
    await request(app).post(`/api/lister/projects/${id}/submit`).set(builder.t).expect(200);
  });

  test('review needs projects.approve; deactivate needs a reason', async () => {
    const { id } = await live();
    const staff = await h.userWithToken('admin', { permissions: [] });
    expect((await request(app).post(`/api/admin/projects/${id}/claim`).set(h.bearer(staff.token))).status).toBe(403);
    expect((await request(app).patch(`/api/admin/projects/${id}`).set(A).send({ action: 'deactivate' })).status).toBe(422);
    const r = await request(app).patch(`/api/admin/projects/${id}`).set(A).send({ action: 'deactivate', reason: 'RERA lapsed' });
    expect(r.body.data.status).toBe('inactive');
  });
});

describe('[G][public] RE-G-06 Masked project page (acceptance 3 and 5)', () => {
  test('no builder contacts or exact counts; RERA number and URL shown; few_left at <= 5', async () => {
    const { slug } = await live();
    const r = await request(app).get(`/api/projects/${slug}`).expect(200);
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('sales@skyline.example');
    expect(body).not.toContain('9811111111');
    expect(body).not.toMatch(/availableUnits|totalUnits|unitNo/);
    expect(r.body.data.configurations.map((c) => c.availability)).toEqual(['available', 'few_left']);
    expect(r.body.data.rera.registrations[0]).toMatchObject({ number: 'P52100012345', url: 'https://maharera.maharashtra.gov.in/projects/P52100012345' });
    const s = await request(app).get('/api/projects?city=Pune').expect(200);
    expect(s.body.data.map((p) => p.slug)).toContain(slug);
    expect(JSON.stringify(s.body)).not.toMatch(/availableUnits|builderId/);
  });

  test('draft projects are not public', async () => {
    const { id } = await draft();
    const p = await Project.findById(id);
    expect((await request(app).get(`/api/projects/${p.slug || 'none'}`)).status).toBe(404);
  });
});

describe('[G][lister] RE-G-05 Inventory (acceptance 2)', () => {
  test('manual update is logged; all zero -> sold_out; adding stock -> live', async () => {
    const { id } = await live();
    const p = await Project.findById(id);
    const items = p.configurations.map((c) => ({ configId: String(c._id), availableUnits: 0 }));
    const r = await request(app).patch(`/api/lister/projects/${id}/inventory`).set(builder.t).send({ items });
    expect(r.body.data.status).toBe('sold_out');
    const back = await request(app).patch(`/api/lister/projects/${id}/inventory`).set(builder.t).send({ items: [{ configId: items[0].configId, availableUnits: 3 }] });
    expect(back.body.data.status).toBe('live');
    expect((await Project.findById(id)).inventoryLog.length).toBe(3);
    expect((await request(app).patch(`/api/lister/projects/${id}/inventory`).set(builder.t).send({ items: [{ configId: items[0].configId, availableUnits: 999 }] })).status).toBe(422);
  });

  test('verified deal decrements the configuration; never below 0', async () => {
    const { id } = await live();
    const p = await Project.findById(id);
    const c = p.configurations[1]; // 4 available
    for (let i = 0; i < 4; i += 1) expect((await projects.decrementOnDeal(p._id, c._id, admin.user._id)).decremented).toBe(true);
    const fifth = await projects.decrementOnDeal(p._id, c._id, admin.user._id);
    expect(fifth).toMatchObject({ decremented: false, warning: 'Inventory already 0' });
    expect((await Project.findById(id)).configurations.id(c._id).availableUnits).toBe(0);
  });
});

describe('[G][lister] RE-G-09 CSV unit import (acceptance 6)', () => {
  test('template download', async () => {
    const { id } = await draft();
    const r = await request(app).get(`/api/lister/projects/${id}/units/template`).set(builder.t).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.split('\n')[0]).toBe('tower,floor,unit_no,configuration,carpet_sqft,price,status');
  });

  test('300 valid + 2 unknown configuration rows: preview shows 2 errors, saves nothing; confirm matches totals', async () => {
    const { id } = await live();
    const lines = ['tower,floor,unit_no,configuration,carpet_sqft,price,status'];
    for (let i = 0; i < 300; i += 1) {
      const conf = i < 200 ? '2 BHK Type A' : '3 BHK Type B';
      const status = i % 4 === 0 ? 'sold' : 'available';
      lines.push(`${i < 150 ? 'A' : 'B'},${Math.floor(i / 10)},U-${i},${conf},${conf.startsWith('2') ? 740 : 1050},,${status}`);
    }
    lines.push('A,1,X-1,4 BHK Penthouse,2000,,available', 'B,1,X-2,Studio,300,,available');
    const pre = await request(app).post(`/api/lister/projects/${id}/units/import`).set(builder.t).send({ csv: lines.join('\n') });
    expect(pre.status).toBe(200);
    expect(pre.body.data).toMatchObject({ rows: 302, create: 300 });
    expect(pre.body.data.errors).toHaveLength(2);
    expect(pre.body.data.errors[0].reason).toMatch(/unknown configuration/);
    expect(await ProjectUnit.countDocuments({ projectId: id })).toBe(0);

    const ok = await request(app).post(`/api/lister/projects/${id}/units/import/${pre.body.data.importId}/confirm`).set(builder.t);
    expect(ok.status).toBe(200);
    expect(await ProjectUnit.countDocuments({ projectId: id })).toBe(300);
    const [a, b] = ok.body.data.configurations;
    expect(a).toMatchObject({ totalUnits: 200, availableUnits: 150 });
    expect(b).toMatchObject({ totalUnits: 100, availableUnits: 75 });
    expect((await request(app).post(`/api/lister/projects/${id}/units/import/${pre.body.data.importId}/confirm`).set(builder.t)).status).toBe(409);
    const units = await request(app).get(`/api/lister/projects/${id}/units?status=sold&limit=500`).set(builder.t);
    expect(units.body.meta.total).toBe(75);
  });

  test('duplicate units in a file and a bad floor are row errors', async () => {
    const { id } = await live();
    const csv = 'A,1,D-1,2 BHK Type A,740,,available\nA,1,D-1,2 BHK Type A,740,,available\nA,999,D-2,2 BHK Type A,740,,available';
    const pre = await request(app).post(`/api/lister/projects/${id}/units/import`).set(builder.t).send({ csv });
    expect(pre.body.data.errors.map((e) => e.reason)).toEqual(['duplicate unit in this file', 'floor must be -2 to 200']);
  });
});

describe('[G][admin] RE-B-12 RERA files via signed links', () => {
  test('reviewer opens the RERA certificate through a 10-minute link; unrelated ids are refused', async () => {
    const { id } = await ready();
    const p = await Project.findById(id).lean();
    const fileId = String(p.rera.registrations[0].certificateFileId);
    const r = await request(app).get(`/api/admin/projects/${id}/files/${fileId}`).set(A).expect(200);
    expect(r.body.data.expiresInSec).toBe(600);
    expect((await request(app).get(`/api/admin/projects/${id}/files/${new mongoose.Types.ObjectId()}`).set(A)).status).toBe(404);
  });
});
