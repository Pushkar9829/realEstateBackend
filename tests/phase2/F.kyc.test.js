// Phase 2 (spec M2) - Module F Lister Verification (KYC) & No-Broker Enforcement.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { User } = require('../../src/modules/auth/models');
const { Property } = require('../../src/modules/listings/models');
const { BrokerFlag, Blocklist } = require('../../src/modules/kyc/models');
const { ensureBaseMasters } = require('../../src/modules/cms/baseMasters');
const kyc = require('../../src/modules/kyc/service');

let app; let admin; let reviewer;
const PDF = Buffer.from('%PDF-1.4\n%kyc test document\n');
const FORM = { legalName: 'Test User', pan: 'ABCDE1234F', address: { line1: '12 Baner Road', city: 'Pune', state: 'Maharashtra', pincode: '411045' } };
const DECL = (name = 'Test User') => ({ statements: [true, true, true, true], typedName: name });

beforeAll(async () => {
  app = await h.setup();
  await ensureBaseMasters();
  admin = await h.userWithToken('superadmin');
  reviewer = await h.userWithToken('admin', { permissions: ['listers.verify'] });
});
afterAll(() => mongoose.disconnect());

async function uploadDoc(token, body = PDF) {
  const r = await request(app).post('/api/uploads?purpose=kyc_doc').set(h.bearer(token)).attach('file', body, { filename: 'doc.pdf', contentType: 'application/pdf' });
  return r.body.data.id;
}

// Lister with the KYC form and required owner documents in place.
async function readyLister(extra = {}, form = FORM) {
  const acct = await h.registerActive(app, 'lister', extra);
  const t = h.bearer(acct.accessToken);
  await request(app).put('/api/lister/kyc').set(t).send(form).expect(200);
  for (const docType of ['id_proof', 'pan_card']) {
    await request(app).post('/api/lister/kyc/documents').set(t).send({ docType, fileId: await uploadDoc(acct.accessToken, Buffer.from(`%PDF-1.4\n${docType}-${acct.email}\n`)) }).expect(200);
  }
  return { ...acct, t };
}

async function verifyKyc(userId) {
  const A = h.bearer(admin.token);
  await request(app).post(`/api/admin/kyc/${userId}/claim`).set(A).expect(200);
  return request(app).post(`/api/admin/kyc/${userId}/decision`).set(A).send({ decision: 'verify' });
}

describe('[F][lister] RE-F-01/02 KYC submission and no-broker declaration', () => {
  test('own KYC shows the four declaration statements and the required documents for the lister type', async () => {
    const acct = await h.registerActive(app, 'lister');
    const res = await request(app).get('/api/lister/kyc').set(h.bearer(acct.accessToken));
    expect(res.body.data.declarationStatements).toHaveLength(4);
    expect(res.body.data.documentTypes.required).toEqual(expect.arrayContaining(['id_proof', 'pan_card']));
    expect(res.body.data.kyc.status).toBe('not_started');
  });

  test('PAN is validated and stored encrypted; builders must give company details', async () => {
    const acct = await h.registerActive(app, 'lister');
    expect((await request(app).put('/api/lister/kyc').set(h.bearer(acct.accessToken)).send({ ...FORM, pan: 'BAD' })).status).toBe(422);
    await request(app).put('/api/lister/kyc').set(h.bearer(acct.accessToken)).send(FORM).expect(200);
    const u = await User.findById(acct.userId).select('+kyc.panEnc');
    expect(u.kyc.panEnc).not.toContain('ABCDE1234F');
    expect(u.kyc.panLast4).toBe('234F');
    const b = await h.registerActive(app, 'lister', { listerType: 'builder', companyName: 'Skyline Homes' });
    expect((await request(app).put('/api/lister/kyc').set(h.bearer(b.accessToken)).send(FORM)).status).toBe(422);
  });

  test('documents must be the lister\'s own kyc_doc uploads of an allowed type', async () => {
    const acct = await h.registerActive(app, 'lister');
    const t = h.bearer(acct.accessToken);
    const wrongType = await request(app).post('/api/lister/kyc/documents').set(t).send({ docType: 'incorporation_certificate', fileId: await uploadDoc(acct.accessToken) });
    expect(wrongType.status).toBe(422);
    const other = await h.registerActive(app, 'lister');
    const foreign = await request(app).post('/api/lister/kyc/documents').set(t).send({ docType: 'id_proof', fileId: await uploadDoc(other.accessToken) });
    expect(foreign.body.error.code).toBe('FILE_NOT_FOUND');
  });

  test('submit needs complete details, required documents and all four statements (acceptance 2)', async () => {
    const acct = await h.registerActive(app, 'lister');
    const t = h.bearer(acct.accessToken);
    const empty = await request(app).post('/api/lister/kyc/submit').set(t).send(DECL());
    expect(empty.status).toBe(422);
    expect(empty.body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['details', 'document:id_proof', 'document:pan_card']));
    const l = await readyLister();
    expect((await request(app).post('/api/lister/kyc/submit').set(l.t).send({ statements: [true, true, true], typedName: 'Test User' })).status).toBe(422);
    const ok = await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    expect(ok.body.data.status).toBe('submitted');
    expect(ok.body.data.declaration).toMatchObject({ typedName: 'Test User', ip: expect.any(String) });
    expect((await request(app).put('/api/lister/kyc').set(l.t).send(FORM)).body.error.code).toBe('KYC_LOCKED');
  });
});

describe('[F][admin] RE-F-05 KYC review', () => {
  test('queue with SLA, claim lock, decision needs a claim', async () => {
    const l = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    const R = h.bearer(reviewer.token);
    const q = await request(app).get('/api/admin/kyc').set(R);
    const row = q.body.data.find((x) => String(x._id) === String(l.userId));
    expect(row.sla).toMatchObject({ hours: 48, level: 'green' });
    const unclaimed = await request(app).post(`/api/admin/kyc/${l.userId}/decision`).set(R).send({ decision: 'verify' });
    expect(unclaimed.body.error.code).toBe('NOT_CLAIMED');
    await request(app).post(`/api/admin/kyc/${l.userId}/claim`).set(R).expect(200);
    const other = await request(app).post(`/api/admin/kyc/${l.userId}/claim`).set(h.bearer(admin.token));
    expect(other.body.error.code).toBe('CLAIMED');
    await request(app).post(`/api/admin/kyc/${l.userId}/release`).set(R).expect(200);
  });

  test('document view gives a short-lived link and is audited', async () => {
    const l = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    const d = await request(app).get(`/api/admin/kyc/${l.userId}`).set(h.bearer(reviewer.token));
    const doc = d.body.data.kyc.documents[0];
    const url = await request(app).get(`/api/admin/kyc/${l.userId}/documents/${doc._id}`).set(h.bearer(reviewer.token));
    expect(url.body.data).toMatchObject({ expiresInSec: 600, url: expect.any(String) });
    const { AuditLog } = require('../../src/core/audit');
    expect(await AuditLog.exists({ action: 'kyc.document_view', entityId: l.userId })).toBeTruthy();
  });

  test('resubmission round trip, then verify; max 3 resubmissions', async () => {
    const l = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    const A = h.bearer(admin.token);
    await request(app).post(`/api/admin/kyc/${l.userId}/claim`).set(A);
    expect((await request(app).post(`/api/admin/kyc/${l.userId}/decision`).set(A).send({ decision: 'resubmit' })).status).toBe(422); // needs a comment
    await request(app).post(`/api/admin/kyc/${l.userId}/decision`).set(A).send({ decision: 'resubmit', comment: 'PAN copy is blurred' }).expect(200);
    await request(app).put('/api/lister/kyc').set(l.t).send(FORM).expect(200);
    const again = await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    expect(again.body.data).toMatchObject({ status: 'submitted', resubmissionCount: 1 });
    const v = await verifyKyc(l.userId);
    expect(v.body.data.status).toBe('verified');
    await User.updateOne({ _id: l.userId }, { $set: { 'kyc.status': 'resubmission_required', 'kyc.resubmissionCount': 3 } });
    expect((await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL())).body.error.code).toBe('RESUBMISSION_LIMIT');
  });

  test('RE-F-09 changing verified KYC data sends it back to review', async () => {
    const l = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    await verifyKyc(l.userId);
    const res = await request(app).put('/api/lister/kyc').set(l.t).send({ ...FORM, address: { ...FORM.address, line1: '99 New Address' } });
    expect(res.body.data.status).toBe('under_review');
  });

  test('auto-checks: a PAN reused by another account is high severity and raises broker flag R4', async () => {
    const a = await readyLister({}, { ...FORM, pan: 'PQRST6789K' });
    await request(app).post('/api/lister/kyc/submit').set(a.t).send(DECL());
    const b = await readyLister({}, { ...FORM, pan: 'PQRST6789K' });
    const res = await request(app).post('/api/lister/kyc/submit').set(b.t).send(DECL());
    expect(res.body.data.autoChecks.map((c) => c.code)).toContain('pan_reused');
    expect(await BrokerFlag.exists({ listerId: b.userId, rule: 'R4' })).toBeTruthy();
  });

  test('reviewers need listers.verify', async () => {
    const staff = await h.userWithToken('admin', { permissions: ['dashboard.view'] });
    expect((await request(app).get('/api/admin/kyc').set(h.bearer(staff.token))).body.error.code).toBe('MISSING_PERMISSION');
  });
});

describe('[F][admin] RE-F-07 Suspend, reinstate, ban', () => {
  let l;
  beforeAll(async () => {
    l = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    await verifyKyc(l.userId);
  });

  const listing = (status, extra = {}) => Property.create({ listingNo: `T-${status}-${Math.random()}`, listerId: l.userId, purpose: 'sale', category: 'residential', type: 'apartment', status, ...extra });

  test('suspend hides every open listing; reinstate restores them (expired ones become expired)', async () => {
    const live = await listing('live', { expiresAt: new Date(Date.now() + 86400000) });
    const old = await listing('live', { expiresAt: new Date(Date.now() - 86400000) });
    const A = h.bearer(admin.token);
    const s = await request(app).patch(`/api/admin/listers/${l.userId}/status`).set(A).send({ action: 'suspend', reason: 'Investigating complaint' });
    expect(s.body.data).toMatchObject({ kycStatus: 'suspended', listingsAffected: 2 });
    expect((await Property.findById(live._id)).status).toBe('suspended');
    const blocked = await request(app).get('/api/lister/properties').set(l.t);
    expect(blocked.status).toBe(423);
    await request(app).patch(`/api/admin/listers/${l.userId}/status`).set(A).send({ action: 'reinstate', reason: 'Cleared' }).expect(200);
    expect((await Property.findById(live._id)).status).toBe('live');
    expect((await Property.findById(old._id)).status).toBe('expired');
  });

  test('listing limit override is stored and reported', async () => {
    const res = await request(app).patch(`/api/admin/listers/${l.userId}/limits`).set(h.bearer(admin.token)).send({ listingLimit: 40 });
    expect(res.body.data.listingLimit).toBe(40);
    const d = await request(app).get(`/api/admin/listers/${l.userId}`).set(h.bearer(admin.token));
    expect(d.body.data.listingLimit).toBe(40);
  });

  test('ban blocklists the identifiers: registering again with the phone is refused (acceptance 4)', async () => {
    const victim = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(victim.t).send(DECL());
    await verifyKyc(victim.userId);
    await request(app).patch(`/api/admin/listers/${victim.userId}/status`).set(h.bearer(admin.token)).send({ action: 'ban', reason: 'Broker posing as owner' }).expect(200);
    expect(await Blocklist.countDocuments({ type: { $in: ['phone', 'email', 'pan'] } })).toBeGreaterThanOrEqual(3);
    const again = await request(app).post('/api/auth/register').send(h.registerBody({ ...h.newIdentity(), phone: victim.phone }, 'lister'));
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('ACCOUNT_BLOCKED');
  });
});

describe('[F][admin] RE-F-06 Broker flags', () => {
  test('manual flag, then confirm_suspend suspends the lister and the live listings (acceptance 3)', async () => {
    const l = await readyLister();
    await request(app).post('/api/lister/kyc/submit').set(l.t).send(DECL());
    await verifyKyc(l.userId);
    const p = await Property.create({ listingNo: 'T-FLAG-1', listerId: l.userId, purpose: 'rent', category: 'residential', type: 'apartment', status: 'live' });
    const A = h.bearer(admin.token);
    const f = await request(app).post('/api/admin/broker-flags').set(A).send({ listerId: String(l.userId), note: 'Same photos as another listing' });
    expect(f.body.data).toMatchObject({ rule: 'manual', status: 'open', flagNo: expect.stringMatching(/^BF/) });
    const list = await request(app).get('/api/admin/broker-flags?status=open').set(A);
    expect(list.body.data.some((x) => x._id === f.body.data._id)).toBe(true);
    const r = await request(app).patch(`/api/admin/broker-flags/${f.body.data._id}`).set(A).send({ resolution: 'confirm_suspend', note: 'Confirmed broker behaviour' });
    expect(r.body.data).toMatchObject({ status: 'resolved', resolution: 'suspended' });
    expect((await User.findById(l.userId)).kyc.status).toBe('suspended');
    expect((await Property.findById(p._id)).status).toBe('suspended');
    expect((await request(app).patch(`/api/admin/broker-flags/${f.body.data._id}`).set(A).send({ resolution: 'dismiss', note: 'again' })).body.error.code).toBe('INVALID_TRANSITION');
  });

  test('one open flag per lister and rule; R2 fires when an owner exceeds 10 active listings', async () => {
    const l = await h.userWithToken('lister', { listerType: 'owner', kyc: { status: 'verified' } });
    await Property.insertMany(Array.from({ length: 11 }, (_, i) => ({ listingNo: `T-R2-${i}-${Date.now()}`, listerId: l.user._id, purpose: 'sale', category: 'residential', type: 'apartment', status: 'live' })));
    const f1 = await kyc.checkListingLimit(l.user);
    const f2 = await kyc.checkListingLimit(l.user);
    expect(f1.rule).toBe('R2');
    expect(String(f2._id)).toBe(String(f1._id));
  });

  test('name similarity helper used by the auto-checks', () => {
    expect(kyc.nameSimilarity('Rahul Sharma', 'RAHUL SHARMA')).toBe(1);
    expect(kyc.nameSimilarity('Rahul Sharma', 'Priya Nair')).toBeLessThan(0.5);
  });
});
