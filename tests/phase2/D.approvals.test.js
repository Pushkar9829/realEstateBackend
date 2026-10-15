// Phase 2 (spec M2) - Module D Admin Approval & Operations (review queue, revisions, agreement registry).
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const fx = require('./fixtures');
const { Property } = require('../../src/modules/listings/models');
const { Agreement } = require('../../src/modules/approvals/models');
const { BrokerFlag } = require('../../src/modules/kyc/models');
const { distanceM } = require('../../src/core/geo');

let app; let w; let admin; let A; let lister;
beforeAll(async () => {
  app = await h.setup();
  w = await fx.world();
  admin = await h.userWithToken('superadmin');
  A = h.bearer(admin.token);
  lister = await fx.verifiedLister('owner');
});
afterAll(() => mongoose.disconnect());

async function submitted(who = lister, opts) {
  const { id } = await fx.fullListing(app, who, w, opts);
  await request(app).post(`/api/lister/properties/${id}/submit`).set(who.t).expect(200);
  return id;
}

describe('[D][admin] RE-D-01/05 Approval queue and claims', () => {
  test('queue sorted by submission age with SLA colouring; claims lock for 30 minutes', async () => {
    const id = await submitted();
    const q = await request(app).get('/api/admin/properties').set(A);
    const row = q.body.data.find((x) => x._id === id);
    expect(row.sla).toMatchObject({ hours: 24, level: 'green' });
    const staff = await h.userWithToken('admin', { permissions: ['properties.approve'] });
    await request(app).post(`/api/admin/properties/${id}/claim`).set(h.bearer(staff.token)).expect(200);
    expect((await request(app).post(`/api/admin/properties/${id}/claim`).set(A)).body.error.code).toBe('CLAIMED');
    expect((await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'reject', reason: 'x' })).body.error.code).toBe('NOT_CLAIMED');
    await request(app).post(`/api/admin/properties/${id}/release`).set(h.bearer(staff.token)).expect(200);
  });

  test('review needs properties.approve', async () => {
    const id = await submitted();
    const staff = await h.userWithToken('admin', { permissions: ['dashboard.view'] });
    expect((await request(app).post(`/api/admin/properties/${id}/claim`).set(h.bearer(staff.token))).body.error.code).toBe('MISSING_PERMISSION');
  });
});

describe('[D][admin] RE-D-02/03 Review decision and media moderation', () => {
  test('approval is blocked without approved photos, unverified KYC or unticked checklist (acceptance D1, A4, F1)', async () => {
    const unverified = await fx.verifiedLister('owner', { kyc: { status: 'submitted' } });
    const id = await submitted(unverified);
    await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
    const noChecklist = await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'approve' });
    expect(noChecklist.status).toBe(422);
    const checklist = Object.fromEntries(['photos_genuine', 'details_match', 'ownership_proof_matches_kyc', 'no_contact_info', 'commission_ok', 'location_ok'].map((k) => [k, true]));
    const blocked = await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'approve', checklist });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details).toEqual(expect.arrayContaining(['Lister KYC is not verified', 'At least 3 approved photos are required']));
  });

  test('photo moderation needs a reason to reject', async () => {
    const id = await submitted();
    const view = await request(app).get(`/api/admin/properties/${id}`).set(A);
    const ph = view.body.data.media.photos[0]._id;
    expect((await request(app).patch(`/api/admin/properties/${id}/media/${ph}/moderation`).set(A).send({ status: 'rejected' })).status).toBe(422);
    const r = await request(app).patch(`/api/admin/properties/${id}/media/${ph}/moderation`).set(A).send({ status: 'rejected', reason: 'Blurred' });
    expect(r.body.data.moderation).toMatchObject({ status: 'rejected', reason: 'Blurred' });
  });

  test('approve: live, expiry by purpose, approximate public pin 300-500 m away, agreement effective', async () => {
    const id = await submitted();
    const res = await fx.approve(app, admin.token, id);
    expect(res.body.data.status).toBe('live');
    const p = await Property.findById(id);
    const days = Math.round((p.expiresAt - p.liveAt) / 86400000);
    expect(days).toBe(90);
    const d = distanceM(p.location.geo, p.location.publicGeo);
    expect(d).toBeGreaterThanOrEqual(295);
    expect(d).toBeLessThanOrEqual(505);
    expect((await Agreement.findById(p.activeAgreementId)).effectiveFrom).toBeTruthy();
    const rent = await submitted(lister, { purpose: 'rent' });
    await fx.approve(app, admin.token, rent);
    const r = await Property.findById(rent);
    expect(Math.round((r.expiresAt - r.liveAt) / 86400000)).toBe(60);
  });

  test('request changes needs a field comment; the lister resubmits; reject needs a reason (acceptance D2)', async () => {
    const id = await submitted();
    await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
    expect((await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'changes' })).status).toBe(422);
    await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'changes', comments: [{ field: 'photos', comment: 'Add a kitchen photo' }] }).expect(200);
    const mine = await request(app).get(`/api/lister/properties/${id}`).set(lister.t);
    expect(mine.body.data).toMatchObject({ status: 'changes_requested', reviewComments: [{ field: 'photos', comment: 'Add a kitchen photo' }] });
    const again = await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    expect(again.body.data.status).toBe('pending_approval');
    expect((await Property.findById(id)).resubmissionCount).toBe(1);
    await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
    expect((await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'reject' })).status).toBe(422);
    const rej = await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'reject', reason: 'Property listed by an agent' });
    expect(rej.body.data.status).toBe('rejected');
  });

  test('broker rule R1: proofs naming more than 2 different owners raise a flag', async () => {
    const l = await fx.verifiedLister('owner');
    for (const owner of ['Owner One', 'Owner Two', 'Owner Three']) {
      const id = await submitted(l);
      const view = await request(app).get(`/api/admin/properties/${id}`).set(A);
      for (const ph of view.body.data.media.photos) await request(app).patch(`/api/admin/properties/${id}/media/${ph._id}/moderation`).set(A).send({ status: 'approved' });
      await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
      const checklist = Object.fromEntries(view.body.data.checklist.map((k) => [k, true]));
      await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'approve', checklist, proofOwnerName: owner }).expect(200);
    }
    expect(await BrokerFlag.exists({ listerId: l.user._id, rule: 'R1' })).toBeTruthy();
  });
});

describe('[D][admin] RE-A-12 / RE-D-07 Revisions of live listings and agreement versions', () => {
  let id;
  beforeAll(async () => {
    id = await submitted();
    await fx.approve(app, admin.token, id);
  });

  test('editing a live description does not change the public listing until the revision is approved (acceptance A8)', async () => {
    const S = fx.STEP(w)[1];
    const newDesc = 'Renovated two bedroom apartment with modular kitchen, new flooring and a large balcony facing the park.';
    const r = await request(app).patch(`/api/lister/properties/${id}/steps/1`).set(lister.t).send({ ...S, description: newDesc });
    expect(r.body.data.applied).toBe('revision');
    expect((await Property.findById(id)).description).toBe(S.description);
    await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t).expect(200);
    const q = await request(app).get('/api/admin/properties?queue=revisions').set(A);
    expect(q.body.data.some((x) => x._id === id)).toBe(true);
    await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
    const view = await request(app).get(`/api/admin/properties/${id}`).set(A);
    const checklist = Object.fromEntries(view.body.data.checklist.map((k) => [k, true]));
    await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'approve', checklist }).expect(200);
    const p = await Property.findById(id);
    expect(p).toMatchObject({ description: newDesc, status: 'live', revisionNo: 1 });
    expect(p.pendingRevision && p.pendingRevision.changes).toBeFalsy();
  });

  test('a price change within 10% applies directly', async () => {
    const r = await request(app).patch(`/api/lister/properties/${id}/steps/4`).set(lister.t).send({ amount: 8200000 });
    expect(r.body.data.applied).toBe('live');
    expect((await Property.findById(id)).price.amount).toBe(820000000);
  });

  test('a new commission % on a live listing supersedes the old agreement only after approval (acceptance D4)', async () => {
    const before = (await Property.findById(id)).activeAgreementId;
    const c = await request(app).post(`/api/lister/properties/${id}/commission`).set(lister.t).send({ percent: 2.5, accept: true, typedName: 'Asha Owner' });
    expect(c.body.data.pendingRevision).toBe(true);
    expect(String((await Property.findById(id)).activeAgreementId)).toBe(String(before));
    await request(app).post(`/api/lister/properties/${id}/submit`).set(lister.t);
    await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
    const view = await request(app).get(`/api/admin/properties/${id}`).set(A);
    await request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'approve', checklist: Object.fromEntries(view.body.data.checklist.map((k) => [k, true])) }).expect(200);
    const p = await Property.findById(id);
    expect(String(p.activeAgreementId)).toBe(c.body.data.agreementId);
    expect(p.commission.percent).toBe(2.5);
    expect((await Agreement.findById(before)).status).toBe('superseded');
  });
});

describe('[D][admin] RE-D-06/10 Agreement registry', () => {
  let agreementId;
  beforeAll(async () => {
    const id = await submitted();
    await fx.approve(app, admin.token, id);
    agreementId = String((await Property.findById(id)).activeAgreementId);
  });

  test('the registry shows evidence; detail verifies the hash and lists versions (acceptance D3)', async () => {
    const list = await request(app).get('/api/admin/agreements').set(A);
    const row = list.body.data.find((x) => x._id === agreementId);
    expect(row).toMatchObject({ acceptedName: 'Asha Owner', ip: expect.any(String), templateVersion: 1 });
    expect(row.textSnapshot).toBeUndefined();
    const d = await request(app).get(`/api/admin/agreements/${agreementId}`).set(A);
    expect(d.body.data).toMatchObject({ hashValid: true, versions: [expect.objectContaining({ version: 1 })] });
  });

  test('export has one CSV row per agreement version (acceptance D6)', async () => {
    const res = await request(app).get('/api/admin/agreements/export').set(A);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.text.trim().split('\n').length - 1).toBe(await Agreement.countDocuments());
  });

  test('signed PDF upload -> countersigned; the lister can download the agreement PDF (acceptance D5)', async () => {
    const f = await fx.upload(app, admin.token, 'signed_agreement', fx.PDF('signed'), 'signed.pdf', 'application/pdf');
    const r = await request(app).post(`/api/admin/agreements/${agreementId}/signed-document`).set(A).send({ fileId: f.id });
    expect(r.body.data.status).toBe('countersigned');
    const pdf = await request(app).get(`/api/lister/agreements/${agreementId}/pdf`).set(lister.t);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    const mine = await request(app).get('/api/lister/agreements').set(lister.t);
    expect(mine.body.data.length).toBeGreaterThanOrEqual(1);
    const other = await fx.verifiedLister('owner');
    expect((await request(app).get(`/api/lister/agreements/${agreementId}`).set(other.t)).status).toBe(404);
  });

  test('terminate makes the linked live listing inactive', async () => {
    const id = await submitted();
    await fx.approve(app, admin.token, id);
    const ag = (await Property.findById(id)).activeAgreementId;
    await request(app).post(`/api/admin/agreements/${ag}/terminate`).set(A).send({ reason: 'Builder breached the terms' }).expect(200);
    expect((await Property.findById(id))).toMatchObject({ status: 'inactive', inactiveReason: 'agreement_terminated' });
  });
});

describe('[D][admin] RE-D-11/12 Admin listing actions and history', () => {
  test('admin pause (review) can only be resumed by admin; feature; extend; history', async () => {
    const id = await submitted();
    await fx.approve(app, admin.token, id);
    await request(app).patch(`/api/admin/properties/${id}`).set(A).send({ action: 'pause', reason: 'Reported as already sold' }).expect(200);
    expect((await request(app).post(`/api/lister/properties/${id}/resume`).set(lister.t)).body.error.code).toBe('ADMIN_PAUSE');
    await request(app).patch(`/api/admin/properties/${id}`).set(A).send({ action: 'resume' }).expect(200);
    const f = await request(app).patch(`/api/admin/properties/${id}`).set(A).send({ action: 'feature', until: new Date(Date.now() + 7 * 86400000).toISOString() });
    expect(f.body.data.featured.on).toBe(true);
    const hist = await request(app).get(`/api/admin/properties/${id}/history`).set(A);
    expect(hist.body.data.statusHistory.map((s) => s.to)).toEqual(expect.arrayContaining(['pending_approval', 'live', 'paused']));
    expect(hist.body.data.audit.length).toBeGreaterThan(0);
    const csv = await request(app).post('/api/admin/properties/export').set(A).send({ status: 'live' });
    expect(csv.text.split('\n')[0]).toMatch(/^listingNo,status/);
  });
});

describe('[D][admin] RE-B-12 Private listing files via signed links', () => {
  test('reviewer opens the ownership proof through a 10-minute link; other ids are refused; views are audited', async () => {
    const id = await submitted();
    const view = await request(app).get(`/api/admin/properties/${id}`).set(A).expect(200);
    const proofId = String(view.body.data.media.ownershipProofs[0].fileId);
    const r = await request(app).get(`/api/admin/properties/${id}/files/${proofId}`).set(A).expect(200);
    expect(r.body.data).toMatchObject({ expiresInSec: 600 });
    expect(r.body.data.url).toMatch(/^http/);
    expect((await request(app).get(`/api/admin/properties/${id}/files/${new mongoose.Types.ObjectId()}`).set(A)).status).toBe(404);
    const { AuditLog } = require('../../src/core/audit');
    expect(await AuditLog.exists({ action: 'listing.file_view', entityId: id })).toBeTruthy();
    const staff = await h.userWithToken('admin', { permissions: [] });
    expect((await request(app).get(`/api/admin/properties/${id}/files/${proofId}`).set(h.bearer(staff.token))).status).toBe(403);
  });
});
