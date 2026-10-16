// Phase 8 - supply-side spec gaps: RE-G-07 linked unit listings, RE-A-14
// watermark, Workflow A4 step 4 agent notices, RE-B-02 builder brand,
// RE-L-10 / RE-G-08 RERA validity job, project.unit_sold.
const request = require('supertest');
const mongoose = require('mongoose');
const sharp = require('sharp');
const h = require('../helpers');
const fx = require('../phase2/fixtures');
const { liveListing } = require('../phase3/fixtures');
const settings = require('../../src/core/settings');
const media = require('../../src/core/media');
const { Property } = require('../../src/modules/listings/models');
const { Project } = require('../../src/modules/projects/models');
const { Lead } = require('../../src/modules/leads/models');
const { Notification } = require('../../src/modules/notifications/models');
const { User } = require('../../src/modules/auth/models');
const listings = require('../../src/modules/listings/service');
const projects = require('../../src/modules/projects/service');
const reraJob = require('../../src/modules/projects/rera-expiry');
const { listerBadge } = require('../../src/modules/masking/serializer');

let app; let w; let admin; let A; let builder; let owner;
beforeAll(async () => {
  app = await h.setup();
  w = await fx.world();
  admin = await h.userWithToken('superadmin');
  A = h.bearer(admin.token);
  builder = await fx.verifiedLister('builder', { brand: { name: 'Skyline Homes', approved: true } });
  owner = await fx.verifiedLister('owner');
});
afterAll(() => mongoose.disconnect());

const notes = (userId, eventKey) => Notification.find({ userId, eventKey }).sort({ createdAt: 1 }).lean();
const days = (n) => new Date(Date.now() + n * 86400000);

const CONFIGS = [
  { name: '2 BHK Type A', bhk: 2, carpetMin: 700, carpetMax: 760, priceMin: 8000000, priceMax: 9500000, totalUnits: 120, availableUnits: 40 },
  { name: '3 BHK Type B', bhk: 3, carpetMin: 1000, carpetMax: 1100, priceMin: 12000000, priceMax: 14000000, totalUnits: 60, availableUnits: 4 },
];

// A builder project taken to `live` through the API (same path as G.projects.test.js).
async function liveProject(who = builder, { validTill, approve = true } = {}) {
  const r = await request(app).post('/api/lister/projects').set(who.t).send({ name: 'Skyline Heights' }).expect(201);
  const id = r.body.data._id;
  const tab = (t, body) => request(app).patch(`/api/lister/projects/${id}/steps/${t}`).set(who.t).send(body).expect(200);
  await tab('details', { name: 'Skyline Heights', description: 'Two towers of 2 and 3 BHK homes next to the Baner hills with a clubhouse, pool and landscaped podium garden.', possession: { status: 'under_construction', date: '2028-12-31' } });
  await tab('location', { cityId: String(w.city._id), localityId: String(w.baner._id), addressLine: 'Survey 42, Baner Road', pincode: '411045', lat: 18.561, lng: 73.789 });
  await tab('amenities', { amenities: ['lift', 'gym'] });
  await tab('configurations', { items: CONFIGS });
  const cert = await fx.upload(app, who.token, 'rera_certificate', fx.PDF(`rera-${Math.random()}`), 'rera.pdf', 'application/pdf');
  await tab('rera', { registrations: [{ number: 'P52100012345', state: 'Maharashtra', url: 'https://maharera.maharashtra.gov.in/projects/P52100012345', certificateFileId: cert.id, ...(validTill ? { validTill } : {}) }] });
  await request(app).post(`/api/lister/projects/${id}/commission`).set(who.t).send({ percent: 2, accept: true, typedName: 'Asha Owner' }).expect(200);
  if (!approve) return Project.findById(id);
  await request(app).post(`/api/lister/projects/${id}/submit`).set(who.t).expect(200);
  await request(app).post(`/api/admin/projects/${id}/claim`).set(A).expect(200);
  await request(app).post(`/api/admin/projects/${id}/decision`).set(A).send({ decision: 'approve', checklist: { rera_verified: true, details_match: true, media_ok: true } }).expect(200);
  return Project.findById(id);
}

describe('[G][lister] RE-G-07 Linked unit listings', () => {
  let project;
  beforeAll(async () => { project = await liveProject(); });

  test('a builder links a draft to a live project; location, amenities and RERA are inherited', async () => {
    const conf = project.configurations[0];
    const r = await request(app).post('/api/lister/properties').set(builder.t).send({ projectId: String(project._id), unitConfigId: String(conf._id) }).expect(201);
    const d = r.body.data;
    expect(d.projectId).toBe(String(project._id));
    expect(d.location).toMatchObject({ city: 'Pune', locality: 'Baner', pincode: '411045', societyName: 'Skyline Heights' });
    expect(d.amenities).toEqual(['lift', 'gym']);
    expect(d.rera).toMatchObject({ numbers: ['P52100012345'], state: 'Maharashtra', inheritedFromProject: true });
    expect(d.rera.certificateFileId).toBeTruthy();
    expect(d.wizard.stepsDone).toEqual(expect.arrayContaining([2, 5]));

    const own = await request(app).get(`/api/lister/properties/${d._id}`).set(builder.t).expect(200);
    expect(own.body.data.project).toMatchObject({ name: 'Skyline Heights', projectNo: project.projectNo, config: { name: '2 BHK Type A' } });
  });

  test('inherited fields are locked; only the private unit number can be set', async () => {
    const conf = project.configurations[1];
    const d = (await request(app).post('/api/lister/properties').set(builder.t).send({ projectId: String(project._id), unitConfigId: String(conf._id) })).body.data;
    const amen = await request(app).patch(`/api/lister/properties/${d._id}/steps/5`).set(builder.t).send({ amenities: ['pool'] });
    expect(amen.status).toBe(409);
    expect(amen.body.error.code).toBe('INHERITED_FROM_PROJECT');
    const loc = await request(app).patch(`/api/lister/properties/${d._id}/steps/2`).set(builder.t).send({ unitNo: 'B-1203', addressLine: 'Somewhere else 12', pincode: '400001' }).expect(200);
    expect(loc.body.data.listing.location).toMatchObject({ unitNo: 'B-1203', pincode: '411045', addressLine: 'Survey 42, Baner Road' });
    const rera = await request(app).patch(`/api/lister/properties/${d._id}/steps/6`).set(builder.t).send({ rera: { numbers: ['P52100099999'] } });
    expect(rera.body.error.code).toBe('INHERITED_FROM_PROJECT');
  });

  test('ownership, live status, configuration and builder type are validated', async () => {
    const other = await fx.verifiedLister('builder');
    const conf = String(project.configurations[0]._id);
    const notMine = await request(app).post('/api/lister/properties').set(other.t).send({ projectId: String(project._id), unitConfigId: conf });
    expect(notMine.status).toBe(422);
    const ownerTry = await request(app).post('/api/lister/properties').set(owner.t).send({ projectId: String(project._id), unitConfigId: conf });
    expect(ownerTry.status).toBe(422);
    const badConf = await request(app).post('/api/lister/properties').set(builder.t).send({ projectId: String(project._id), unitConfigId: String(new mongoose.Types.ObjectId()) });
    expect(badConf.status).toBe(422);
    const draftProject = await liveProject(builder, { approve: false });
    const notLive = await request(app).post('/api/lister/properties').set(builder.t).send({ projectId: String(draftProject._id), unitConfigId: String(draftProject.configurations[0]._id) });
    expect(notLive.status).toBe(422);
    expect(await Property.countDocuments({ listerId: other.user._id })).toBe(0);
  });

  test('step 1 can link an existing draft; the linked listing submits with the project RERA and goes live', async () => {
    const draft = (await request(app).post('/api/lister/properties').set(builder.t)).body.data;
    const steps = fx.STEP(w);
    await request(app).patch(`/api/lister/properties/${draft._id}/steps/1`).set(builder.t)
      .send({ ...steps[1], projectId: String(project._id), unitConfigId: String(project.configurations[0]._id) }).expect(200);
    for (const s of [3, 4]) await request(app).patch(`/api/lister/properties/${draft._id}/steps/${s}`).set(builder.t).send(steps[s]).expect(200);
    for (let i = 0; i < 3; i += 1) {
      const f = await fx.upload(app, builder.token, 'property_photo', await fx.photo(), `u${i}.jpg`, 'image/jpeg');
      await request(app).post(`/api/lister/properties/${draft._id}/media`).set(builder.t).send({ kind: 'photo', fileId: f.id }).expect(201);
    }
    const low = await request(app).post(`/api/lister/properties/${draft._id}/commission`).set(builder.t).send({ percent: 1, accept: true, typedName: 'Asha Owner' });
    expect(low.status).toBe(422); // a unit listing may only raise the project commission
    await request(app).post(`/api/lister/properties/${draft._id}/commission`).set(builder.t).send({ percent: 2, accept: true, typedName: 'Asha Owner' }).expect(200);
    const sub = await request(app).post(`/api/lister/properties/${draft._id}/submit`).set(builder.t);
    expect(sub.status).toBe(200);
    const r = await fx.approve(app, admin.token, draft._id, { builder: true });
    expect(r.status).toBe(200);
    const p = await Property.findById(draft._id);
    expect(p).toMatchObject({ status: 'live' });
    expect(String(p.projectId)).toBe(String(project._id));
  });
});

describe('[A][system] RE-A-14 Watermark on the large rendition', () => {
  afterEach(() => settings.set('media.watermark', false));

  test('watermark on changes the 1600 px output but not the duplicate-photo hash or the thumbnail', async () => {
    const buffer = await fx.photo({ width: 3000, height: 2000 });
    const file = { buffer, mimetype: 'image/jpeg', originalname: 'a.jpg' };
    await settings.set('media.watermark', false);
    const plain = await media.processImage(file, 'property_photo');
    await settings.set('media.watermark', true);
    const marked = await media.processImage(file, 'property_photo');
    expect(plain.meta).toMatchObject({ width: 1600, height: 1067 });
    expect(marked.meta).toMatchObject({ width: 1600, height: 1067, watermarked: true });
    expect(Buffer.compare(plain.file.buffer, marked.file.buffer)).not.toBe(0);
    expect(marked.meta.ahash).toBe(plain.meta.ahash);
    expect(Buffer.compare(plain.thumbnail, marked.thumbnail)).toBe(0);
    // pixels in the bottom-right corner (where the mark sits) differ
    const crop = (b) => sharp(b).extract({ left: 1300, top: 960, width: 280, height: 90 }).raw().toBuffer();
    expect(Buffer.compare(await crop(plain.file.buffer), await crop(marked.file.buffer))).not.toBe(0);
  });

  test('a logo watermark (data URL) is supported; private purposes are never watermarked', async () => {
    const logo = await sharp({ create: { width: 200, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    await settings.set('media.watermark', { logo: `data:image/png;base64,${logo.toString('base64')}`, opacity: 0.8 });
    const buffer = await fx.photo();
    const file = { buffer, mimetype: 'image/jpeg', originalname: 'a.jpg' };
    const marked = await media.processImage(file, 'project_media');
    expect(marked.meta.watermarked).toBe(true);
    const v = await media.processImage(file, 'verification_photo');
    expect(v.meta.watermarked).toBeUndefined();
  });

  test('uploads through the API carry the watermark when the setting is on', async () => {
    const { FileModel } = require('../../src/core/storage');
    const original = await fx.photo();
    const plain = await fx.upload(app, owner.token, 'property_photo', original, 'p.jpg', 'image/jpeg');
    await settings.set('media.watermark', true);
    const marked = await fx.upload(app, owner.token, 'property_photo', original, 'w.jpg', 'image/jpeg');
    expect(marked.width).toBeLessThanOrEqual(1600);
    const [a, b] = await Promise.all([FileModel.findById(plain.id), FileModel.findById(marked.id)]);
    expect(a.sha256).not.toBe(b.sha256); // same upload, different stored bytes
    expect(a.meta.ahash).toBe(b.meta.ahash); // duplicate-photo check unaffected
  });
});

describe('[A][system] Workflow A4 step 4: agents on open leads are told about listing changes', () => {
  let agent; let agent2; let p;
  beforeAll(async () => {
    agent = await h.userWithToken('agent');
    agent2 = await h.userWithToken('agent');
    p = await liveListing(w, owner);
    await Lead.create({ leadNo: `L-T-${Date.now()}`, propertyId: p._id, stage: 'contacted', assignedTo: agent.user._id, buyer: { name: 'B', phone: '+919700000001' } });
    await Lead.create({ leadNo: `L-T2-${Date.now()}`, propertyId: p._id, stage: 'closed_lost', assignedTo: agent2.user._id, buyer: { name: 'C', phone: '+919700000002' } });
  });

  test('pause and resume by the lister notify the agent (in-app); closed leads are ignored', async () => {
    await request(app).post(`/api/lister/properties/${p._id}/pause`).set(owner.t).send({ reason: 'Under renovation' }).expect(200);
    const paused = await notes(agent.user._id, 'listing.paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ title: `${p.listingNo} is paused` });
    expect(paused[0].body).toContain('Under renovation');
    expect(paused[0].link).toMatch(/^\/agent\/leads\/[a-f0-9]{24}$/);
    expect(await notes(agent2.user._id, 'listing.paused')).toHaveLength(0);

    await request(app).post(`/api/lister/properties/${p._id}/resume`).set(owner.t).expect(200);
    expect(await notes(agent.user._id, 'listing.resumed')).toHaveLength(1);
  });

  test('deactivation and sold elsewhere notify with the reason', async () => {
    await request(app).post(`/api/lister/properties/${p._id}/deactivate`).set(owner.t).send({ reason: 'no_longer_available' }).expect(200);
    const n = await notes(agent.user._id, 'listing.deactivated');
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('no longer available');

    const p2 = await liveListing(w, owner, { liveAt: days(-20) });
    await Lead.create({ leadNo: `L-T3-${Date.now()}`, linkedProperties: [p2._id], stage: 'qualified', assignedTo: agent.user._id, buyer: { name: 'D', phone: '+919700000003' } });
    await request(app).post(`/api/lister/properties/${p2._id}/deactivate`).set(owner.t).send({ reason: 'sold_outside', saleDate: days(-1).toISOString() }).expect(200);
    const all = await notes(agent.user._id, 'listing.deactivated');
    expect(all).toHaveLength(2);
    expect(all[1].body).toContain('sold outside the platform');
  });

  test('expiry by the freshness job and an auto-pause notify too', async () => {
    const p3 = await liveListing(w, owner);
    await Lead.create({ leadNo: `L-T4-${Date.now()}`, propertyId: p3._id, stage: 'new', assignedTo: agent2.user._id, buyer: { name: 'E', phone: '+919700000004' } });
    await Property.updateOne({ _id: p3._id }, { $set: { expiresAt: days(-1) } });
    await listings.runFreshness();
    const n = await notes(agent2.user._id, 'listing.deactivated');
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('listing expired');
  });
});

describe('[F][lister+admin] RE-B-02 Builder brand', () => {
  let b; let reviewer;
  beforeAll(async () => {
    b = await fx.verifiedLister('builder');
    reviewer = await h.userWithToken('admin', { permissions: ['listers.verify'] });
  });

  test('a builder requests a brand; it shows publicly only after admin approval', async () => {
    const logo = await fx.upload(app, b.token, 'avatar', await fx.photo({ width: 400, height: 400 }), 'logo.jpg', 'image/jpeg');
    const r = await request(app).patch('/api/lister/profile/brand').set(b.t).send({ name: 'Riverstone Developers', logoFileId: logo.id }).expect(200);
    expect(r.body.data).toMatchObject({ approved: false, pending: { name: 'Riverstone Developers' }, publicLabel: 'Verified Builder' });
    expect(listerBadge(await User.findById(b.user._id).lean())).toBe('Verified Builder');
    expect((await notes(admin.user._id, 'brand.submitted')).length).toBeGreaterThanOrEqual(1);

    const detail = await request(app).get(`/api/admin/listers/${b.user._id}`).set(A).expect(200);
    expect(detail.body.data.brand.pending).toMatchObject({ name: 'Riverstone Developers' });

    const ok = await request(app).post(`/api/admin/listers/${b.user._id}/approve-brand`).set(h.bearer(reviewer.token)).send({ decision: 'approve' }).expect(200);
    expect(ok.body.data).toMatchObject({ name: 'Riverstone Developers', approved: true, pending: null, publicLabel: 'Verified Builder · Riverstone Developers' });
    expect(ok.body.data.logoUrl).toBeTruthy();
    const u = await User.findById(b.user._id).lean();
    expect(listerBadge(u)).toBe('Verified Builder · Riverstone Developers');
    expect(await notes(b.user._id, 'brand.decided')).toHaveLength(1);
  });

  test('a rejected change keeps the approved brand; reject needs a reason; nothing pending is 409', async () => {
    await request(app).patch('/api/lister/profile/brand').set(b.t).send({ name: 'Riverstone Luxe' }).expect(200);
    const noReason = await request(app).post(`/api/admin/listers/${b.user._id}/approve-brand`).set(A).send({ decision: 'reject' });
    expect(noReason.status).toBe(422);
    const rej = await request(app).post(`/api/admin/listers/${b.user._id}/approve-brand`).set(A).send({ decision: 'reject', reason: 'Name does not match the company documents' }).expect(200);
    expect(rej.body.data).toMatchObject({ name: 'Riverstone Developers', approved: true, pending: null, rejectReason: 'Name does not match the company documents' });
    const again = await request(app).post(`/api/admin/listers/${b.user._id}/approve-brand`).set(A).send({});
    expect(again.status).toBe(409);
  });

  test('guards: builders only, contact details blocked, permission required', async () => {
    expect((await request(app).patch('/api/lister/profile/brand').set(owner.t).send({ name: 'Owner Brand' })).status).toBe(403);
    const phone = await request(app).patch('/api/lister/profile/brand').set(b.t).send({ name: 'Call 9876543210' });
    expect(phone.status).toBe(422);
    const staff = await h.userWithToken('admin', { permissions: ['dashboard.view'] });
    const denied = await request(app).post(`/api/admin/listers/${b.user._id}/approve-brand`).set(h.bearer(staff.token)).send({});
    expect(denied.body.error.code).toBe('MISSING_PERMISSION');
    const mine = await request(app).get('/api/lister/profile/brand').set(b.t).expect(200);
    expect(mine.body.data.name).toBe('Riverstone Developers');
  });

  test('a brand set at sign-up (not approved, nothing pending) can be approved as it is', async () => {
    const nb = await fx.verifiedLister('builder', { brand: { name: 'Signup Brand Pvt', approved: false } });
    const r = await request(app).post(`/api/admin/listers/${nb.user._id}/approve-brand`).set(A).send({}).expect(200);
    expect(r.body.data).toMatchObject({ name: 'Signup Brand Pvt', approved: true });
  });
});

describe('[L][G][system] RE-L-10 / RE-G-08 RERA validity job', () => {
  afterAll(() => settings.set('rera.agentRegistrations', []));

  test('super admins are told 30 and 7 days before an agent registration ends, not on other days', async () => {
    const now = new Date();
    await settings.set('rera.agentRegistrations', [
      { state: 'Maharashtra', number: 'A51900000001', validTill: days(30).toISOString() },
      { state: 'Karnataka', number: 'PRM/KA/RERA/1', validTill: days(7).toISOString() },
      { state: 'Goa', number: 'AGGOA0001', validTill: days(12).toISOString() },
    ]);
    const before = (await notes(admin.user._id, 'rera.agent_registration_expiring')).length;
    const out = await reraJob.run(now);
    expect(out.agentRegistrations).toBe(2);
    const n = await notes(admin.user._id, 'rera.agent_registration_expiring');
    expect(n.length - before).toBe(2);
    expect(n.map((x) => x.title).join(' ')).toMatch(/Maharashtra[\s\S]*Karnataka|Karnataka[\s\S]*Maharashtra/);
    expect(n.some((x) => /Goa/.test(x.title))).toBe(false);
    const staff = await h.userWithToken('admin', { permissions: ['projects.approve'] });
    expect(await notes(staff.user._id, 'rera.agent_registration_expiring')).toHaveLength(0); // super admins only
    expect(reraJob.daysUntil(days(30), now)).toBe(30);
  });

  test('a project whose RERA validity is near is flagged and the builder and reviewers are told; once past, its listings get a warning', async () => {
    const reviewer = await h.userWithToken('admin', { permissions: ['projects.approve'] });
    const b = await fx.verifiedLister('builder');
    const proj = await liveProject(b, { validTill: days(20).toISOString() });
    const linked = (await request(app).post('/api/lister/properties').set(b.t).send({ projectId: String(proj._id), unitConfigId: String(proj.configurations[0]._id) }).expect(201)).body.data;

    let out = await reraJob.run(new Date());
    expect(out.projects.expiring).toBeGreaterThanOrEqual(1);
    let p = await Project.findById(proj._id).lean();
    expect(p.reraExpiry).toMatchObject({ status: 'expiring', number: 'P52100012345' });
    const bn = await notes(b.user._id, 'project.rera_expiring');
    expect(bn).toHaveLength(1);
    expect(bn[0].link).toBe(`/lister/projects/${proj._id}`);
    const rn = await notes(reviewer.user._id, 'project.rera_expiring');
    expect(rn.some((x) => x.link === `/admin/projects/${proj._id}`)).toBe(true);

    // the next day nothing new (flag unchanged, not the 7-day mark)
    await reraJob.run(new Date(Date.now() + 86400000));
    expect(await notes(b.user._id, 'project.rera_expiring')).toHaveLength(1);

    out = await reraJob.run(days(21));
    p = await Project.findById(proj._id).lean();
    expect(p.reraExpiry.status).toBe('expired');
    expect(await notes(b.user._id, 'project.rera_expiring')).toHaveLength(2);
    expect((await Property.findById(linked._id).lean()).warnings).toContain('rera_expired');
  });
});

describe('[G][system] project.unit_sold', () => {
  test('a deal decrement tells the builder the new available count', async () => {
    const b = await fx.verifiedLister('builder');
    const proj = await liveProject(b);
    const conf = proj.configurations[0];
    const r = await projects.decrementOnDeal(proj._id, conf._id, admin.user._id);
    expect(r.decremented).toBe(true);
    const n = await notes(b.user._id, 'project.unit_sold');
    expect(n).toHaveLength(1);
    expect(n[0].body).toBe('Configuration 2 BHK Type A: available units now 39');
    expect(n[0].link).toBe(`/lister/projects/${proj._id}`);
  });

  test('no notice when inventory is already 0', async () => {
    const b = await fx.verifiedLister('builder');
    const proj = await liveProject(b);
    const conf = proj.configurations[1];
    await Project.updateOne({ _id: proj._id, 'configurations._id': conf._id }, { $set: { 'configurations.$.availableUnits': 0 } });
    const r = await projects.decrementOnDeal(proj._id, conf._id, admin.user._id);
    expect(r.decremented).toBe(false);
    expect(await notes(b.user._id, 'project.unit_sold')).toHaveLength(0);
  });
});
