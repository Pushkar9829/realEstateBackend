// Control Center adapter (control-center/docs/CC_CONTRACT.md): signing, scopes,
// ops endpoints, staff / settings governance, maintenance, kill switches, key rotation, SSO.
const cc = require('../ccHelpers');

const JWKS_PORT = 47102;
cc.configure({ jwksPort: JWKS_PORT });

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { setup, userWithToken, bearer } = require('../helpers');
const { User } = require('../../src/modules/auth/models');
const { AuditLog } = require('../../src/core/audit');
const { CcLink } = require('../../src/modules/control/models');
const state = require('../../src/modules/control/state');
const ccSso = require('../../src/modules/control/sso');
const outbox = require('../../src/core/outbox');

let app;
let issuer;
const s = (method, path, body, opts) => cc.signed(request, app, method, path, body, opts);
const actor = { actor: cc.OWNER };

beforeAll(async () => { issuer = await cc.startIssuer(JWKS_PORT); });
beforeEach(async () => { app = await setup(); state.clear(); ccSso.resetCache(); });
afterAll(async () => { await issuer.close(); await mongoose.disconnect(); });

describe('[CC] signed requests', () => {
  test('health answers a correctly signed request', async () => {
    const r = await s('GET', '/api/cc/health');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ platform: 'realestate', status: 'ok', db: { state: 'up' }, maintenance: { on: false } });
    expect(r.body.data.flags).toEqual({ signups: false, enquiries: false, hub_delivery: false });
  });

  test('missing, wrong, stale or replayed signatures are rejected', async () => {
    expect((await request(app).get('/api/cc/health')).body.error.code).toBe('missing_signature');
    expect((await s('GET', '/api/cc/health', undefined, { secret: 'x'.repeat(40) })).body.error.code).toBe('bad_signature');
    expect((await s('GET', '/api/cc/health', undefined, { keyId: 'cck_other_000000000000' })).body.error.code).toBe('unknown_key');
    const old = await s('GET', '/api/cc/health', undefined, { ts: String(Math.floor(Date.now() / 1000) - 600) });
    expect(old.body.error.code).toBe('timestamp_out_of_window');
    expect(old.body.error.details.serverTime).toBeGreaterThan(0);
    const nonce = 'fixed-nonce-000000000001';
    expect((await s('GET', '/api/cc/health', undefined, { nonce })).status).toBe(200);
    expect((await s('GET', '/api/cc/health', undefined, { nonce })).body.error.code).toBe('replayed_nonce');
    // body tampering: signature covers the body hash
    const r = await cc.signed(request, app, 'POST', '/api/cc/maintenance', { on: false }, actor);
    expect(r.status).toBe(200);
  });

  test('the query string is part of the signature', async () => {
    const t = String(Math.floor(Date.now() / 1000));
    const good = await s('GET', '/api/cc/summary?range=7d', undefined, { ts: t, nonce: 'nonce-for-query-test-01' });
    expect(good.body.data.range).toBe('7d');
  });
});

describe('[CC] ops endpoints (no personal data)', () => {
  test('summary, approvals, security and integrations', async () => {
    const lister = await userWithToken('lister', { listerType: 'owner', kyc: { status: 'submitted', submittedAt: new Date() } });
    await mongoose.connection.collection('properties').insertOne({ listingNo: 'PD-1001', status: 'pending_approval', deletedAt: null, title: 'Flat', submittedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
    await mongoose.connection.collection('deals').insertOne({ dealNo: 'DL-7', status: 'verified', commissionAmount: 250000, review: { verifiedAt: new Date() }, createdAt: new Date() });
    const sum = await s('GET', '/api/cc/summary?range=today');
    const k = Object.fromEntries(sum.body.data.kpis.map((x) => [x.key, x.value]));
    expect(k.deals_closed).toBe(1);
    expect(k.commission).toBe(250000);
    expect(k.listings_new).toBe(1);
    const ap = await s('GET', '/api/cc/approvals');
    const q = Object.fromEntries(ap.body.data.queues.map((x) => [x.key, x]));
    expect(q.listing_review.count).toBe(1);
    expect(q.listing_review.items[0]).toMatchObject({ ref: 'PD-1001', path: expect.stringMatching(/^\/admin\/approvals\//) });
    expect(q.lister_kyc.count).toBe(1);
    expect(JSON.stringify(ap.body)).not.toContain(lister.user.email);
    const sec = await s('GET', '/api/cc/security');
    expect(sec.body.data).toHaveProperty('lockedAccounts');
    expect(sec.body.data).toHaveProperty('activeSessions');
    const integ = await s('GET', '/api/cc/integrations');
    expect(integ.body.data.outbox).toMatchObject({ pending: 0, dead: 0 });
  });

  test('scopes: a platform that grants only ops.read refuses staff calls', async () => {
    const env = require('../../src/config/env');
    const saved = env.CC_ALLOWED_SCOPES;
    env.CC_ALLOWED_SCOPES = 'ops.read';
    const r = await s('GET', '/api/cc/staff');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('scope_denied');
    expect((await s('GET', '/api/cc/health')).status).toBe(200);
    env.CC_ALLOWED_SCOPES = saved;
  });
});

describe('[CC] staff governance (double audit)', () => {
  test('list, disable everywhere, enable, force logout, reset 2FA, role change', async () => {
    const { user } = await userWithToken('agent');
    const list = await s('GET', '/api/cc/staff');
    expect(list.body.data.items.find((i) => i.id === String(user._id))).toMatchObject({ role: 'agent', status: 'active', viaControlCenter: false });
    expect((await s('PATCH', `/api/cc/staff/${user._id}`, { status: 'disabled' })).body.error.code).toBe('missing_actor');
    const dis = await s('PATCH', `/api/cc/staff/${user._id}`, { status: 'disabled', reason: 'Left', revokeSessions: true }, actor);
    expect(dis.status).toBe(200);
    expect((await User.findById(user._id)).status).toBe('disabled');
    expect(await AuditLog.countDocuments({ action: 'staff.disable' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'cc.staff.disable' })).toBe(1);
    const link = await CcLink.findOne({ sub: cc.OWNER.sub });
    expect(String((await AuditLog.findOne({ action: 'staff.disable' })).actorId)).toBe(String(link.userId));
    expect((await s('PATCH', `/api/cc/staff/${user._id}`, { status: 'active' }, actor)).status).toBe(200);
    expect((await s('PATCH', `/api/cc/staff/${user._id}`, { action: 'force_logout' }, actor)).status).toBe(200);
    expect((await s('PATCH', `/api/cc/staff/${user._id}`, { action: 'reset_2fa' }, actor)).status).toBe(200);
    const role = await s('PATCH', `/api/cc/staff/${user._id}`, { role: 'manager' }, actor);
    expect(role.body.data.result.role).toBe('manager');
    const viewer = await s('PATCH', `/api/cc/staff/${user._id}`, { action: 'force_logout' }, { actor: { ...cc.OWNER, sub: '665f00000000000000000009', role: 'viewer' } });
    expect(viewer.status).toBe(403);
  });

  test('invite creates a staff account through the platform service', async () => {
    const r = await s('POST', '/api/cc/staff', { name: 'New Agent', email: 'new.agent@example.com', phone: '+919811100011', role: 'agent' }, actor);
    expect(r.status).toBe(201);
    expect((await User.findById(r.body.data.id)).mustChangePassword).toBe(true);
  });
});

describe('[CC] settings explorer', () => {
  test('typed update with validation and history', async () => {
    const list = await s('GET', '/api/cc/settings');
    const item = list.body.data.items.find((i) => i.key === 'auth.maxSessions');
    expect(item.type).toBe('number');
    const bad = await s('PATCH', '/api/cc/settings', { key: 'auth.maxSessions', value: 'ten' }, actor);
    expect(bad.status).toBe(422);
    const ok = await s('PATCH', '/api/cc/settings', { key: 'auth.maxSessions', value: 4, reason: 'tighten' }, actor);
    expect(ok.body.data).toMatchObject({ key: 'auth.maxSessions', after: 4 });
    const hist = await s('GET', '/api/cc/settings/history?key=auth.maxSessions');
    expect(hist.body.data.items[0]).toMatchObject({ key: 'auth.maxSessions', after: 4 });
  });
});

describe('[CC] maintenance mode and kill switches', () => {
  test('maintenance blocks public writes but not admins or reads; banner endpoint', async () => {
    await s('POST', '/api/cc/maintenance', { on: true, message: 'Back at 10 pm' }, actor).expect(200);
    const st = await request(app).get('/api/cc-status');
    expect(st.body.data.maintenance).toEqual({ on: true, message: 'Back at 10 pm' });
    const blocked = await request(app).post('/api/contact').send({});
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('MAINTENANCE');
    expect((await request(app).get('/api/health')).status).toBe(200);
    const admin = await userWithToken('superadmin');
    const adminWrite = await request(app).post('/api/me/enquiries').set(bearer(admin.token)).send({});
    expect(adminWrite.body.error && adminWrite.body.error.code).not.toBe('MAINTENANCE');
    const login = await request(app).post('/api/auth/login').send({ identifier: 'x@y.z', password: 'nope' });
    expect(login.body.error.code).not.toBe('MAINTENANCE');
    await s('POST', '/api/cc/maintenance', { on: false }, actor).expect(200);
    expect((await request(app).post('/api/contact').send({})).body.error.code).not.toBe('MAINTENANCE');
  });

  test('pausing sign-ups answers 423; hub delivery pause keeps events in the outbox', async () => {
    await s('POST', '/api/cc/flags', { key: 'signups', paused: true, reason: 'spam wave' }, actor).expect(200);
    const r = await request(app).post('/api/auth/register').send({});
    expect(r.status).toBe(423);
    expect(r.body.error.details.flag).toBe('signups');
    const flags = await s('GET', '/api/cc/flags');
    expect(flags.body.data.items.find((f) => f.key === 'signups').paused).toBe(true);
    await s('POST', '/api/cc/flags', { key: 'hub_delivery', paused: true }, actor).expect(200);
    await outbox.record('lead.created', { x: 1 });
    await outbox.dispatchDue({ enabled: true, sendUnreferred: true });
    expect((await outbox.Outbox.findOne()).status).toBe('pending');
    expect((await s('POST', '/api/cc/flags', { key: 'nope', paused: true }, actor)).status).toBe(422);
  });
});

describe('[CC] key rotation', () => {
  test('new key works at once, the old one during the grace window', async () => {
    const r = await s('POST', '/api/cc/keys/rotate', { keyId: 'cck_realestate_rotated01', secret: 'n'.repeat(40) }, actor);
    expect(r.body.data.rotated).toBe(true);
    state.clear();
    expect((await s('GET', '/api/cc/health', undefined, { keyId: 'cck_realestate_rotated01', secret: 'n'.repeat(40) })).status).toBe(200);
    expect((await s('GET', '/api/cc/health')).status).toBe(200); // previous key, still in grace
    await mongoose.connection.collection('ccstates').updateOne({ _id: 'state' }, { $set: { 'key.previousUntil': new Date(Date.now() - 1000) } });
    state.clear();
    expect((await s('GET', '/api/cc/health')).body.error.code).toBe('unknown_key');
  });
});

describe('[CC] single sign-on', () => {
  test('assertion -> linked super admin session, audit, single use', async () => {
    const assertion = issuer.issue('realestate');
    const r = await request(app).post('/api/auth/cc-sso').send({ assertion });
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy();
    expect(r.body.data.refreshToken).toBeTruthy();
    expect(r.body.data.user.role).toBe('superadmin');
    expect(r.body.data.cc).toMatchObject({ path: '/admin/kyc', ctx: { ccUrl: 'http://localhost:5185' } });
    const me = await request(app).get('/api/me').set(bearer(r.body.data.accessToken));
    expect(me.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'auth.cc_sso' })).toBe(1);
    const again = await request(app).post('/api/auth/cc-sso').send({ assertion });
    expect(again.body.error.code).toBe('SSO_REPLAYED');
    // second hop reuses the same linked account
    await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('realestate') }).expect(200);
    expect(await CcLink.countDocuments()).toBe(1);
    const list = await s('GET', '/api/cc/staff');
    expect(list.body.data.items.filter((i) => i.viaControlCenter)).toHaveLength(1);
  });

  test('wrong audience, long lifetime, foreign key, unknown role and disabled link are refused', async () => {
    expect((await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('ecommerce') })).body.error.code).toBe('SSO_INVALID');
    expect((await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('realestate', {}, { expiresIn: 600 }) })).body.error.code).toBe('SSO_INVALID');
    const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect((await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('realestate', {}, { key: privateKey }) })).body.error.code).toBe('SSO_INVALID');
    expect((await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('realestate', { role: 'buyer' }) })).body.error.code).toBe('SSO_ROLE_DENIED');
    const hs = jwt.sign({ role: 'superadmin' }, 'secret', { audience: 'realestate', issuer: 'control-center', subject: 'x', jwtid: 'j1', expiresIn: 60 });
    expect((await request(app).post('/api/auth/cc-sso').send({ assertion: hs })).body.error.code).toBe('SSO_INVALID');
    await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('realestate') }).expect(200);
    const link = await CcLink.findOne();
    await User.updateOne({ _id: link.userId }, { $set: { status: 'disabled' } });
    expect((await request(app).post('/api/auth/cc-sso').send({ assertion: issuer.issue('realestate') })).body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});
