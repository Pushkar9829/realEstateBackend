// RE-M-10 / RE-L-11: a signed-in user gives and withdraws self-grantable consents
// (cookie banner "Accept analytics", WhatsApp updates); sales contact is not self-grantable.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { Consent } = require('../../src/modules/auth/models');

let app; let B; let buyer;
beforeAll(async () => {
  app = await h.setup();
  buyer = await h.userWithToken('buyer');
  B = h.bearer(buyer.token);
});
afterAll(() => mongoose.disconnect());

describe('[M][public] RE-M-10 Consent ledger: give and withdraw', () => {
  test('accepting analytics records one active consent (idempotent); essential-only withdraws it', async () => {
    await request(app).post('/api/me/consents').set(B).send({ purpose: 'analytics', source: 'banner' }).expect(201);
    await request(app).post('/api/me/consents').set(B).send({ purpose: 'analytics' }).expect(201);
    expect(await Consent.countDocuments({ subjectId: buyer.user._id, purpose: 'analytics', withdrawnAt: null })).toBe(1);
    const ledger = await request(app).get('/api/me/consents').set(B).expect(200);
    expect(JSON.stringify(ledger.body.data)).toMatch(/analytics/);
    await request(app).post('/api/me/consents/analytics/withdraw').set(B).expect(200);
    expect(await Consent.countDocuments({ subjectId: buyer.user._id, purpose: 'analytics', withdrawnAt: null })).toBe(0);
  });

  test('sales contact and partner sharing cannot be self-granted; guests are refused', async () => {
    expect((await request(app).post('/api/me/consents').set(B).send({ purpose: 'sales_contact' })).body.error.code).toBe('CONSENT_NOT_SELF_GRANTABLE');
    expect((await request(app).post('/api/me/consents').set(B).send({ purpose: 'partner_sharing' })).status).toBe(400);
    expect((await request(app).post('/api/me/consents').send({ purpose: 'analytics' })).status).toBe(401);
  });
});

describe('[M][admin] RE-M-10 Lister deletion requests', () => {
  test('a lister with a live listing is blocked; with nothing active the account is anonymised', async () => {
    const { User, DeletionRequest } = require('../../src/modules/auth/models');
    const { Property } = require('../../src/modules/listings/models');
    const A = h.bearer((await h.userWithToken('superadmin')).token);
    const lister = await h.userWithToken('lister', { listerType: 'owner', billing: { name: 'Old Name', state: 'Maharashtra' } });
    const p = await Property.collection.insertOne({ listingNo: 'RE26-999901', listerId: lister.user._id, status: 'live', deletedAt: null });
    const r = await DeletionRequest.create({ userId: lister.user._id, reason: 'Selling done' });
    const blocked = await request(app).patch(`/api/admin/deletion-requests/${r._id}`).set(A).send({ status: 'completed', note: 'Identity confirmed' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LISTER_HAS_ACTIVE_RECORDS');
    await Property.collection.updateOne({ _id: p.insertedId }, { $set: { status: 'sold' } });
    await request(app).patch(`/api/admin/deletion-requests/${r._id}`).set(A).send({ status: 'completed', note: 'Identity confirmed' }).expect(200);
    const u = await User.findById(lister.user._id);
    expect(u).toMatchObject({ status: 'anonymised', name: 'Anonymised lister' });
    expect(u.billing && u.billing.name).toBeFalsy();
  });
});

describe('[B][integrations] RE-K-08 WhatsApp STOP opt-out', () => {
  test('a STOP reply withdraws the WhatsApp consent and turns off lead opt-in', async () => {
    const settings = require('../../src/core/settings');
    const { Consent } = require('../../src/modules/auth/models');
    const { Lead, BuyerContact } = require('../../src/modules/leads/models');
    await settings.set('whatsapp.enabled', true);
    const phone = '+919812399001';
    const contact = await BuyerContact.create({ phone, name: 'Wa Buyer' });
    await Consent.create({ subjectType: 'buyer_contact', subjectId: contact._id, purpose: 'whatsapp_updates', source: 'enquiry' });
    await Lead.collection.insertOne({ leadNo: 'LD26-999001', buyer: { phone, contactId: contact._id }, stage: 'new', whatsappOptIn: true });
    const body = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.stop1', from: '919812399001', type: 'text', text: { body: 'STOP' } }] } }] }] };
    const r = await request(app).post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(200);
    expect(r.body.data.messages[0].result).toBe('opted_out');
    expect(await Consent.countDocuments({ subjectId: contact._id, purpose: 'whatsapp_updates', withdrawnAt: null })).toBe(0);
    expect((await Lead.collection.findOne({ leadNo: 'LD26-999001' })).whatsappOptIn).toBe(false);
  });
});
