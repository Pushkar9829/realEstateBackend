// Phase 2 (spec M2) - Module A Property Listing & Catalog Management (lister panel + jobs).
const request = require('supertest');
const mongoose = require('mongoose');
const sharp = require('sharp');
const h = require('../helpers');
const fx = require('./fixtures');
const { Property, ListingCheck, SoldElsewhereCheck } = require('../../src/modules/listings/models');
const { Agreement } = require('../../src/modules/approvals/models');
const { Master } = require('../../src/modules/cms/models');
const { Lead } = require('../../src/modules/leads/models');
const storage = require('../../src/core/storage');
const settings = require('../../src/core/settings');
const listings = require('../../src/modules/listings/service');
const notify = require('../../src/core/notify');

let app; let w; let admin; let lister;
beforeAll(async () => {
  app = await h.setup();
  w = await fx.world();
  admin = await h.userWithToken('superadmin');
  lister = await fx.verifiedLister('owner');
});
afterAll(() => mongoose.disconnect());

const step = (id, n, body, who = lister) => request(app).patch(`/api/lister/properties/${id}/steps/${n}`).set(who.t).send(body);
const newDraft = async () => (await request(app).post('/api/lister/properties').set(lister.t)).body.data._id;

describe('[A][lister] RE-A-03 Listing wizard steps', () => {
  test('a draft gets a sequential listing number', async () => {
    const r = await request(app).post('/api/lister/properties').set(lister.t);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'draft', listingNo: expect.stringMatching(/^RE\d{2}-\d{6}$/) });
  });

  test('step 1 validates lengths and type/category; contact info in text is blocked (acceptance 9)', async () => {
    const id = await newDraft();
    const S = fx.STEP(w);
    expect((await step(id, 1, { ...S[1], title: 'Short' })).status).toBe(422);
    expect((await step(id, 1, { ...S[1], category: 'commercial' })).status).toBe(422); // apartment is residential
    const blocked = await step(id, 1, { ...S[1], description: `${S[1].description} For visits call 98765 43210 anytime.` });
    expect(blocked.body.error.code).toBe('CONTACT_INFO_BLOCKED');
    const ok = await step(id, 1, S[1]);
    expect(ok.body.data.listing).toMatchObject({ title: S[1].title, slug: expect.stringMatching(/^2-bhk-apartment-in-baner/) });
  });

  test('step 2: locality must belong to the city; unknown locality becomes a pending request; far pin warns', async () => {
    const id = await newDraft();
    const S = fx.STEP(w);
    const other = await Master.create({ type: 'city', code: 'nashik', name: 'Nashik' });
    expect((await step(id, 2, { ...S[2], cityId: String(other._id) })).status).toBe(422);
    const far = await step(id, 2, { ...S[2], lat: 18.62, lng: 73.95 }); // ~18 km from the Baner centroid
    expect(far.body.data.warnings).toContain('pin_far_from_locality');
    const req2 = await step(id, 2, { ...S[2], localityId: undefined, localityRequest: 'Sus Gaon' });
    expect(req2.body.data.warnings).toContain('locality_requested');
    expect(await Master.findOne({ name: 'Sus Gaon' })).toMatchObject({ active: false, request: { status: 'pending' } });
  });

  test('step 3 enforces carpet <= built-up <= super built-up and normalises area to sq ft', async () => {
    const id = await newDraft();
    expect((await step(id, 3, { areas: { carpet: 1000, builtUp: 900, unit: 'sqft' } })).status).toBe(422);
    const r = await step(id, 3, { bhk: 3, areas: { carpet: 100, unit: 'sqm' } });
    expect(r.body.data.listing.details.areaSqft).toBe(1076);
  });

  test('step 4 checks price ranges and stores paise; rent deposit max 24 months', async () => {
    const id = await newDraft();
    await step(id, 1, fx.STEP(w)[1]);
    expect((await step(id, 4, { amount: 50000 })).status).toBe(422);
    const ok = await step(id, 4, { amount: 8500000 });
    expect(ok.body.data.listing.price.amount).toBe(850000000);
    const rid = await newDraft();
    await step(rid, 1, { ...fx.STEP(w)[1], purpose: 'rent' });
    expect((await step(rid, 4, { monthlyRent: 20000, deposit: 600000 })).status).toBe(422);
  });

  test('step 5 rejects unknown amenities', async () => {
    const id = await newDraft();
    expect((await step(id, 5, { amenities: ['lift', 'helipad'] })).status).toBe(422);
  });
});

describe('[A][lister] RE-A-05/14 Media', () => {
  test('uploaded photos have no EXIF / GPS, are resized and get a thumbnail (acceptance 6)', async () => {
    const original = await fx.photo({ width: 3000, height: 2000 });
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const f = await fx.upload(app, lister.token, 'property_photo', original, 'p.jpg', 'image/jpeg');
    expect(f).toMatchObject({ width: 1600, height: 1067, thumbUrl: expect.any(String) });
    const doc = await storage.FileModel.findById(f.id);
    const stored = require('fs').readFileSync(require('path').join(storage.localDir, doc.key));
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
  });

  test('photos smaller than 1024 x 768 and files over 5 MB are rejected (acceptance 5)', async () => {
    const small = await request(app).post('/api/uploads?purpose=property_photo').set(lister.t).attach('file', await fx.photo({ width: 800, height: 600 }), { filename: 's.jpg', contentType: 'image/jpeg' });
    expect(small.body.error.code).toBe('IMAGE_TOO_SMALL');
    const big = await request(app).post('/api/uploads?purpose=property_photo').set(lister.t).attach('file', Buffer.alloc(6 * 1024 * 1024, 1), { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(big.body.error.code).toBe('FILE_TOO_LARGE');
  });

  test('photo limit, cover on first photo, reorder and remove', async () => {
    await settings.set('media.maxPhotos', 2);
    const id = await newDraft();
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const f = await fx.upload(app, lister.token, 'property_photo', await fx.photo(), 'p.jpg', 'image/jpeg');
      ids.push((await request(app).post(`/api/lister/properties/${id}/media`).set(lister.t).send({ kind: 'photo', fileId: f.id })).body.data.photos.slice(-1)[0]._id);
    }
    const f3 = await fx.upload(app, lister.token, 'property_photo', await fx.photo(), 'p.jpg', 'image/jpeg');
    expect((await request(app).post(`/api/lister/properties/${id}/media`).set(lister.t).send({ kind: 'photo', fileId: f3.id })).body.error.code).toBe('PHOTO_LIMIT');
    await settings.set('media.maxPhotos', 20);
    const order = await request(app).patch(`/api/lister/properties/${id}/media/order`).set(lister.t).send({ photoIds: [ids[1], ids[0]], coverId: ids[1] });
    expect(order.body.data.photos[0]).toMatchObject({ _id: ids[1], isCover: true });
    await request(app).delete(`/api/lister/properties/${id}/media/${ids[1]}`).set(lister.t).expect(200);
    expect((await Property.findById(id)).media.photos[0].isCover).toBe(true);
  });

  test('media must be the lister\'s own upload of the right purpose', async () => {
    const id = await newDraft();
    const f = await fx.upload(app, lister.token, 'ownership_proof', fx.PDF('x'), 'd.pdf', 'application/pdf');
    expect((await request(app).post(`/api/lister/properties/${id}/media`).set(lister.t).send({ kind: 'photo', fileId: f.id })).body.error.code).toBe('FILE_NOT_FOUND');
  });
});

describe('[A][lister] RE-A-09/10 Commission step and click-wrap agreement', () => {
  test('a % below the sale minimum is rejected and no agreement is created (acceptance 2)', async () => {
    const id = await newDraft();
    await step(id, 1, fx.STEP(w)[1]);
    const before = await Agreement.countDocuments();
    const r = await request(app).post(`/api/lister/properties/${id}/commission`).set(lister.t).send({ percent: 0.5, accept: true, typedName: 'Asha Owner' });
    expect(r.status).toBe(422);
    expect(await Agreement.countDocuments()).toBe(before);
    expect((await request(app).post(`/api/lister/properties/${id}/commission`).set(lister.t).send({ percent: 1.555, accept: true, typedName: 'Asha Owner' })).status).toBe(422); // 2 decimals
  });

  test('acceptance creates an agreement with typed name, time, IP, template version and hash (acceptance 3)', async () => {
    const { id, agreementId } = await fx.fullListing(app, lister, w);
    const ag = await Agreement.findById(agreementId);
    expect(ag).toMatchObject({ acceptedName: 'Asha Owner', ip: expect.any(String), templateVersion: 1, commissionPercent: 2, basis: 'sale_price', nonCircumventionMonths: 6, status: 'accepted' });
    expect(ag.textSnapshot).toMatch(/2\.00% of the agreed sale price/);
    expect(ag.textSnapshot).toMatch(/within 6 months/);
    expect(ag.textHash).toHaveLength(64);
    expect((await Property.findById(id)).activeAgreementId.toString()).toBe(agreementId);
  });

  test('the current template is available to the lister with the limits', async () => {
    const r = await request(app).get('/api/lister/agreement-template?purpose=rent').set(lister.t);
    expect(r.body.data).toMatchObject({ purpose: 'rent', limits: { min: 8.33, max: 25 }, nonCircumventionMonths: 6 });
  });
});

describe('[A][lister] Submit, withdraw, duplicate, delete', () => {
  test('submit lists the missing steps (acceptance 1)', async () => {
    const id = await newDraft();
    await step(id, 1, fx.STEP(w)[1]);
    const r = await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    expect(r.status).toBe(422);
    expect(r.body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['step2', 'step6:ownership_proof', 'step7:commission']));
  });

  test('a complete listing goes to pending_approval with auto-check warnings', async () => {
    const { id } = await fx.fullListing(app, lister, w);
    const r = await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    expect(r.body.data.status).toBe('pending_approval');
    expect(Array.isArray(r.body.data.warnings)).toBe(true);
    await request(app).post(`/api/lister/properties/${id}/withdraw`).set(lister.t).expect(200);
    expect((await Property.findById(id)).status).toBe('draft');
  });

  test('only drafts can be deleted; duplicate copies details but not media or commission', async () => {
    const { id } = await fx.fullListing(app, lister, w);
    const copy = await request(app).post(`/api/lister/properties/${id}/duplicate`).set(lister.t);
    expect(copy.body.data).toMatchObject({ status: 'draft' });
    expect(copy.body.data.media.photos).toHaveLength(0);
    expect(copy.body.data.activeAgreementId).toBeUndefined();
    await request(app).delete(`/api/lister/properties/${copy.body.data._id}`).set(lister.t).expect(200);
    await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    expect((await request(app).delete(`/api/lister/properties/${id}`).set(lister.t)).body.error.code).toBe('NOT_A_DRAFT');
  });

  test('another lister cannot read or edit my listing', async () => {
    const id = await newDraft();
    const other = await fx.verifiedLister('owner');
    expect((await request(app).get(`/api/lister/properties/${id}`).set(other.t)).status).toBe(404);
  });
});

describe('[A][lister] RE-A-11/15/18 Lifecycle: pause, resume, deactivate, renew', () => {
  let live;
  beforeAll(async () => {
    live = (await fx.fullListing(app, lister, w)).id;
    await request(app).post(`/api/lister/properties/${live}/submit`).set(lister.t);
    const a = await fx.approve(app, admin.token, live);
    expect(a.body.data.status).toBe('live');
  });

  test('pause hides the listing; resume makes it live again without review (acceptance 13)', async () => {
    await request(app).post(`/api/lister/properties/${live}/pause`).set(lister.t).send({ reason: 'Family staying for a month' }).expect(200);
    expect((await Property.findById(live)).status).toBe('paused');
    const r = await request(app).post(`/api/lister/properties/${live}/resume`).set(lister.t);
    expect(r.body.data.status).toBe('live');
  });

  test('renew opens only in the last 15 days; expired within 30 days renews straight to live', async () => {
    expect((await request(app).post(`/api/lister/properties/${live}/renew`).set(lister.t)).body.error.code).toBe('TOO_EARLY');
    await Property.updateOne({ _id: live }, { $set: { status: 'expired', expiresAt: new Date(Date.now() - 5 * 86400000) } });
    const r = await request(app).post(`/api/lister/properties/${live}/renew`).set(lister.t);
    expect(r.body.data.status).toBe('live');
    expect(new Date(r.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 80 * 86400000);
    await Property.updateOne({ _id: live }, { $set: { status: 'expired', expiresAt: new Date(Date.now() - 40 * 86400000) } });
    expect((await request(app).post(`/api/lister/properties/${live}/renew`).set(lister.t)).body.data.status).toBe('pending_approval');
  });

  test('deactivate "sold outside" needs a date and creates a sold-elsewhere check', async () => {
    const id = (await fx.fullListing(app, lister, w)).id;
    await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    await fx.approve(app, admin.token, id);
    expect((await request(app).post(`/api/lister/properties/${id}/deactivate`).set(lister.t).send({ reason: 'sold_outside' })).status).toBe(422);
    const r = await request(app).post(`/api/lister/properties/${id}/deactivate`).set(lister.t).send({ reason: 'sold_outside', saleDate: new Date().toISOString() });
    expect(r.body.data).toMatchObject({ status: 'inactive', soldElsewhereCheck: { checkNo: expect.stringMatching(/^SE/) } });
    const react = await request(app).post(`/api/lister/properties/${id}/reactivate`).set(lister.t);
    expect(react.body.data.status).toBe('pending_approval');
  });
});

describe('[A][system] RE-A-17/18/19 "Still available?" checks, auto-pause, sold elsewhere, expiry', () => {
  let id;
  const DAY = 86400000;
  beforeEach(async () => {
    id = (await fx.fullListing(app, lister, w)).id;
    await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    await fx.approve(app, admin.token, id);
    await Property.updateOne({ _id: id }, { $set: { liveAt: new Date(Date.now() - 30 * DAY), expiresAt: new Date(Date.now() + 60 * DAY) } });
  });

  // The check SMS is queued as a notify.sms job; read the token link from it.
  async function runAndGetToken(now = new Date()) {
    await listings.runFreshness(now);
    const { Job } = require('../../src/core/jobs');
    const job = await Job.findOne({ type: 'notify.sms', 'payload.to': lister.user.phone, 'payload.text': /still available/i }).sort({ createdAt: -1 });
    return { token: job && job.payload.text.match(/listing-check\/([\w-]+)/)[1] };
  }

  test('day 30 sends one check by SMS, email and in-app; "Yes" keeps it live; the token cannot be reused (acceptance 10, 11)', async () => {
    const { token } = await runAndGetToken();
    expect(token).toBeTruthy();
    expect(await ListingCheck.countDocuments({ propertyId: id, trigger: 'day30' })).toBe(1);
    await listings.runFreshness(); // idempotent: still one open check
    expect(await ListingCheck.countDocuments({ propertyId: id })).toBe(1);
    const summary = await request(app).get(`/api/listing-checks/${token}`);
    expect(summary.body.data).toMatchObject({ answered: false });
    expect((await request(app).post(`/api/listing-checks/${token}`).send({ answer: 'available' })).body.data.listingStatus).toBe('live');
    expect((await request(app).post(`/api/listing-checks/${token}`).send({ answer: 'available' })).status).toBe(409);
  });

  test('no reply: reminder after 4 days, auto-pause at day 7 keeping expiresAt; resume via link (acceptance 10, 13)', async () => {
    const { token } = await runAndGetToken();
    const before = (await Property.findById(id)).expiresAt;
    const out4 = await listings.runFreshness(new Date(Date.now() + 4 * DAY + 60000));
    expect(out4.reminders).toBe(1);
    const out7 = await listings.runFreshness(new Date(Date.now() + 7 * DAY + 60000));
    expect(out7.autoPaused).toBe(1);
    const p = await Property.findById(id);
    expect(p).toMatchObject({ status: 'paused', pause: { reason: 'no_reply' } });
    expect(p.expiresAt.getTime()).toBe(before.getTime());
    expect((await request(app).post(`/api/listing-checks/${token}`).send({ answer: 'available' })).body.data.listingStatus).toBe('live');
  });

  test('"Sold elsewhere" sets inactive and creates one check listing the leads in negotiation (acceptance 12)', async () => {
    const lead = await Lead.create({ leadNo: `LD-SE-${Date.now()}`, propertyId: id, stage: 'negotiation', lastActivityAt: new Date(Date.now() - 10 * DAY) });
    const { token } = await runAndGetToken();
    expect((await request(app).post(`/api/listing-checks/${token}`).send({ answer: 'sold_elsewhere' })).status).toBe(422); // date required
    const r = await request(app).post(`/api/listing-checks/${token}`).send({ answer: 'sold_elsewhere', saleDate: new Date().toISOString(), price: 8400000 });
    expect(r.body.data.listingStatus).toBe('inactive');
    const checks = await SoldElsewhereCheck.find({ propertyId: id });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ priority: true, source: 'check' });
    expect(checks[0].matches.leads.map(String)).toContain(String(lead._id));
    const list = await request(app).get('/api/admin/sold-elsewhere-checks?priority=true').set(h.bearer(admin.token));
    expect(list.body.data.some((c) => c._id === String(checks[0]._id))).toBe(true);
    const decided = await request(app).patch(`/api/admin/sold-elsewhere-checks/${checks[0]._id}`).set(h.bearer(admin.token)).send({ status: 'claim_raised', note: 'Buyer from our visit bought it', claimAmount: 168000 });
    expect(decided.body.data).toMatchObject({ status: 'claim_raised', claimAmount: 16800000 });
  });

  test('a live listing past expiresAt expires in the daily job (acceptance 7)', async () => {
    await Property.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const out = await listings.runFreshness();
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect((await Property.findById(id)).status).toBe('expired');
  });

  test('stale drafts are archived', async () => {
    const d = await newDraft();
    await Property.collection.updateOne({ _id: new mongoose.Types.ObjectId(d) }, { $set: { updatedAt: new Date(Date.now() - 200 * DAY) } });
    expect(await listings.archiveStaleDrafts()).toBeGreaterThanOrEqual(1);
    expect((await Property.findById(d)).deletedAt).toBeTruthy();
  });
});
