// Phase 3 - RE-A-20 photo verification (workflow A6) and its public badge.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx2 = require('../phase2/fixtures');
const { liveListing, seedWorld } = require('./fixtures');
const { Property } = require('../../src/modules/listings/models');

let app; let w; let lister; let A;
beforeAll(async () => {
  app = await h.setup();
  ({ w, lister } = await seedWorld());
  const admin = await h.userWithToken('superadmin');
  A = h.bearer(admin.token);
});
afterAll(() => mongoose.disconnect());

const at = (p, dLat = 0) => ({ lat: p.location.geo.coordinates[1] + dLat, lng: p.location.geo.coordinates[0], accuracy: 20 });

async function capture(token, p, n = 4) {
  for (let i = 0; i < n; i += 1) {
    const g = at(p);
    await request(app).post(`/api/verify-photos/${token}/photos`).field('lat', g.lat).field('lng', g.lng).field('accuracy', 20).field('capturedAt', new Date().toISOString())
      .attach('file', await fx2.photo(), { filename: `v${i}.jpg`, contentType: 'image/jpeg' }).expect(200);
  }
}

describe('[A][lister] RE-A-20 Photo verification session', () => {
  test('location must be within 200 m; capture page never shows the pin', async () => {
    const p = await liveListing(w, lister);
    const s = await request(app).post(`/api/lister/properties/${p._id}/verification/photo-session`).set(lister.t).expect(201);
    const token = s.body.data.token;
    const page = await request(app).get(`/api/verify-photos/${token}`).expect(200);
    expect(JSON.stringify(page.body)).not.toMatch(/coordinates|geo|addressLine/);
    expect(page.body.data).toMatchObject({ status: 'open', minPhotos: 4 });
    const far = await request(app).post(`/api/verify-photos/${token}/location`).send(at(p, 0.01)); // ~1.1 km
    expect(far.body.error.code).toBe('TOO_FAR');
    const fuzzy = await request(app).post(`/api/verify-photos/${token}/location`).send({ ...at(p), accuracy: 500 });
    expect(fuzzy.status).toBe(422);
    const ok = await request(app).post(`/api/verify-photos/${token}/location`).send(at(p)).expect(200);
    expect(ok.body.data.distanceM).toBeLessThan(5);
  });

  test('4 live photos -> submit -> QA approve -> badge on the public page; reject path needs a reason', async () => {
    const p = await liveListing(w, lister);
    const s = await request(app).post(`/api/lister/properties/${p._id}/verification/photo-session`).set(lister.t).expect(201);
    const token = s.body.data.token;
    await request(app).post(`/api/verify-photos/${token}/location`).send(at(p)).expect(200);
    await capture(token, p, 3);
    expect((await request(app).post(`/api/verify-photos/${token}/submit`).send({})).status).toBe(422); // only 3
    await capture(token, p, 1);
    await request(app).post(`/api/verify-photos/${token}/submit`).send({ addToGallery: false }).expect(200);
    expect((await request(app).post(`/api/verify-photos/${token}/submit`).send({})).body.error.code).toBe('SESSION_CLOSED');

    const q = await request(app).get('/api/admin/verification/photo-sessions').set(A).expect(200);
    const row = q.body.data.find((x) => x.propertyId._id === String(p._id));
    const detail = await request(app).get(`/api/admin/verification/photo-sessions/${row._id}`).set(A).expect(200);
    expect(detail.body.data.photos).toHaveLength(4);
    expect(detail.body.data.photos[0].url).toMatch(/^http/);
    expect((await request(app).post(`/api/admin/verification/photo-sessions/${row._id}/decision`).set(A).send({ decision: 'approve' })).body.error.code).toBe('NOT_CLAIMED');
    await request(app).post(`/api/admin/verification/photo-sessions/${row._id}/claim`).set(A).expect(200);
    await request(app).post(`/api/admin/verification/photo-sessions/${row._id}/decision`).set(A).send({ decision: 'approve' }).expect(200);
    const pub = await request(app).get(`/api/properties/${p.slug}`).expect(200);
    const badge = pub.body.data.badges.find((b) => b.code === 'photo_verified');
    expect(badge.tooltip).toMatch(/location check/);
    expect(JSON.stringify(pub.body)).not.toMatch(/verification_photo|sessionId/);
    const status = await request(app).get(`/api/lister/properties/${p._id}/verification`).set(lister.t).expect(200);
    expect(status.body.data.photo.status).toBe('verified');
  });

  test('max 3 sessions per listing in 30 days', async () => {
    const p = await liveListing(w, lister);
    for (let i = 0; i < 3; i += 1) await request(app).post(`/api/lister/properties/${p._id}/verification/photo-session`).set(lister.t).expect(201);
    expect((await request(app).post(`/api/lister/properties/${p._id}/verification/photo-session`).set(lister.t)).body.error.code).toBe('ATTEMPT_LIMIT');
  });

  test('moving the exact pin more than 200 m removes the badge', async () => {
    const p = await liveListing(w, lister, { status: 'pending_approval', verification: { photo: { status: 'verified', verifiedAt: new Date(), expiresAt: new Date(Date.now() + 86400000) } } });
    const step2 = fx2.STEP(w)[2];
    await request(app).patch(`/api/lister/properties/${p._id}/steps/2`).set(lister.t).send({ ...step2, lat: p.location.geo.coordinates[1] + 0.01, lng: p.location.geo.coordinates[0] }).expect(200);
    expect((await Property.findById(p._id)).verification.photo.status).toBe('none');
  });
});
