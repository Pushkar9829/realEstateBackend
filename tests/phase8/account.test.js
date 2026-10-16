// Phase 8 - account and admin-tooling spec gaps: staff users screen
// (RE-S-ADM-16: role edit, enable, list columns), agent availability and leave
// (RE-S-AGT-16), account page data rights (RE-S-PUB-10 / RE-M-10: my data
// download status, my deletion request, notification preferences), deletion
// decisions (RE-S-ADM-22) and the new-device sign-in email (auth.new_device_login).
const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const h = require('../helpers');
const { User, DeletionRequest, LoginHistory } = require('../../src/modules/auth/models');
const { Team } = require('../../src/modules/teams/models');
const { AuditLog } = require('../../src/core/audit');
const jobs = require('../../src/core/jobs');
const { deviceLabel } = require('../../src/modules/auth/services/auth.service');

const { Job } = jobs;
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let app; let superadmin; let S;

beforeAll(async () => {
  app = await h.setup();
  superadmin = await h.userWithToken('superadmin', { name: 'Root Admin' });
  S = h.bearer(superadmin.token);
});
afterAll(() => mongoose.disconnect());

// Two-step login with a chosen user agent (the device that signs in).
async function loginAs(identifier, password, ua) {
  await h.resetOtpLimits(identifier);
  const one = await request(app).post('/api/auth/login').set('User-Agent', ua).send({ identifier, password, channel: 'email' });
  expect(one.status).toBe(200);
  const two = await request(app).post('/api/auth/login/verify-2fa').set('User-Agent', ua).send({ challengeToken: one.body.data.challengeToken, code: h.otpFor(identifier) });
  expect(two.status).toBe(200);
  return two.body.data;
}
const newDeviceMails = (to) => Job.find({ type: 'notify.email', 'payload.to': to, 'payload.subject': /New login/ }).lean();

describe('[M] auth.new_device_login', () => {
  test('device labels are readable', () => {
    expect(deviceLabel(CHROME_WIN)).toBe('Chrome on Windows');
    expect(deviceLabel(SAFARI_IOS)).toBe('Safari on iOS');
    expect(deviceLabel('')).toBe('an unknown device');
  });

  test('no alert on the first sign-in or from a known device; an email from a new device', async () => {
    const id = h.newIdentity('dev');
    const user = await User.create({
      name: 'Device User', email: id.email, phone: h.e164(id.phone), role: 'buyer', status: 'active',
      emailVerified: true, phoneVerified: true, passwordHash: await bcrypt.hash(id.password, 4),
    });
    await loginAs(id.email, id.password, CHROME_WIN); // first ever sign-in
    expect(await newDeviceMails(id.email)).toHaveLength(0);
    await loginAs(id.email, id.password, CHROME_WIN); // same ip + device
    expect(await newDeviceMails(id.email)).toHaveLength(0);

    await loginAs(id.email, id.password, SAFARI_IOS); // new device
    const mails = await newDeviceMails(id.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].payload.text).toMatch(/^New login on Safari on iOS at .+ from \S+\./);
    expect(mails[0].payload.text).not.toMatch(/\b\d{6}\b/); // never mistaken for an OTP
    expect(await LoginHistory.countDocuments({ userId: user._id, success: true })).toBe(3);
  });
});

describe('[J][admin] RE-S-ADM-16 staff users', () => {
  let mgr;
  test('list shows role, status, 2FA method and last login', async () => {
    const id = h.newIdentity('stf');
    const res = await request(app).post('/api/admin/staff').set(S).send({ role: 'manager', name: 'Mona Manager', email: id.email, phone: id.phone });
    expect(res.status).toBe(201);
    mgr = res.body.data;
    const list = await request(app).get('/api/admin/staff').set(S).query({ q: 'Mona' });
    expect(list.body.data[0]).toMatchObject({ _id: mgr._id, role: 'manager', status: 'active', twoFactor: { method: 'email' } });
    expect(list.body.data[0].permissions).toEqual(expect.arrayContaining(['leads.assign']));
  });

  test('role change recomputes permissions, revokes sessions and is audited', async () => {
    const before = await User.findById(mgr._id);
    const { RefreshToken } = require('../../src/modules/auth/models');
    await RefreshToken.create({ userId: before._id, familyId: 'fam-x', tokenHash: `h-${Date.now()}`, expiresAt: new Date(Date.now() + 86400000) });
    const res = await request(app).patch(`/api/admin/staff/${mgr._id}`).set(S).send({ role: 'agent', permissions: ['verification.field'] });
    expect(res.status).toBe(200);
    const u = await User.findById(mgr._id).select('+permissions');
    expect(u.role).toBe('agent');
    expect(u.permissions).toEqual(['verification.field']);
    expect(await RefreshToken.countDocuments({ userId: u._id, revokedAt: null })).toBe(0);
    const log = await AuditLog.findOne({ action: 'staff.edit', entityId: u._id }).sort({ at: -1 });
    expect(log.before.role).toBe('manager');
    expect(log.after.role).toBe('agent');
  });

  test('only a super admin grants the admin role; a super admin is never demoted', async () => {
    const staffAdmin = await h.userWithToken('admin', { permissions: ['staff.manage'] });
    const deny = await request(app).patch(`/api/admin/staff/${mgr._id}`).set(h.bearer(staffAdmin.token)).send({ role: 'admin', permissions: ['dashboard.view'] });
    expect(deny.status).toBe(403);
    const other = await h.userWithToken('superadmin');
    const demote = await request(app).patch(`/api/admin/staff/${other.user._id}`).set(S).send({ role: 'manager' });
    expect(demote.body.error.code).toBe('SUPERADMIN_PROTECTED');
  });

  test('disable then enable', async () => {
    await request(app).post(`/api/admin/staff/${mgr._id}/disable`).set(S).send({ reason: 'On long leave' }).expect(200);
    const again = await request(app).post(`/api/admin/staff/${mgr._id}/disable`).set(S).send({ reason: 'On long leave' });
    expect(again.body.error.code).toBe('ALREADY_DISABLED');
    const res = await request(app).post(`/api/admin/staff/${mgr._id}/enable`).set(S);
    expect(res.body.data).toMatchObject({ enabled: true, status: 'active' });
    expect((await User.findById(mgr._id)).status).toBe('active');
    expect(await AuditLog.countDocuments({ action: 'staff.enable', entityId: mgr._id })).toBe(1);
    expect((await request(app).post(`/api/admin/staff/${mgr._id}/enable`).set(S)).body.error.code).toBe('NOT_DISABLED');
  });

  test('enable needs staff.manage', async () => {
    const plain = await h.userWithToken('admin', { permissions: ['dashboard.view'] });
    expect((await request(app).post(`/api/admin/staff/${mgr._id}/enable`).set(h.bearer(plain.token))).status).toBe(403);
  });
});

describe('[J][agent] RE-S-AGT-16 availability and leave', () => {
  test('GET is null without a team; leave dates are saved and read back', async () => {
    const agent = await h.userWithToken('agent');
    const G = h.bearer(agent.token);
    const none = await request(app).get('/api/agent/availability').set(G);
    expect(none.status).toBe(200);
    expect(none.body.data).toBeNull();

    await Team.create({ name: `Team ${Date.now()}`, members: [{ agentId: agent.user._id, capacity: 20 }] });
    const bad = await request(app).patch('/api/agent/availability').set(G).send({ leaveFrom: '2026-11-10', leaveTo: '2026-11-01' });
    expect(bad.status).toBe(422);
    await request(app).patch('/api/agent/availability').set(G).send({ available: false, leaveFrom: '2026-11-01', leaveTo: '2026-11-05' }).expect(200);
    const mine = await request(app).get('/api/agent/availability').set(G);
    expect(mine.body.data).toMatchObject({ available: false, capacity: 20 });
    expect(mine.body.data.leaveFrom.slice(0, 10)).toBe('2026-11-01');
    await request(app).patch('/api/agent/availability').set(G).send({ available: true, leaveFrom: null, leaveTo: null }).expect(200);
    expect((await request(app).get('/api/agent/availability').set(G)).body.data.leaveFrom).toBeFalsy();
  });
});

describe('[M][public] RE-S-PUB-10 account page data rights', () => {
  test('my data download: null, queued, then ready with a link', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const A = h.bearer(acct.accessToken);
    expect((await request(app).get('/api/me/data-export').set(A)).body.data).toBeNull();
    const started = await request(app).post('/api/me/data-export').set(A);
    expect(started.status).toBe(201);
    expect((await request(app).get('/api/me/data-export').set(A)).body.data).toMatchObject({ status: 'queued' });
    // run the queued job handler directly (the shared queue also holds earlier test emails)
    await require('../../src/modules/auth/services/account.service').buildDataExport({ exportId: String(started.body.data.exportId) });
    const ready = await request(app).get('/api/me/data-export').set(A);
    expect(ready.body.data).toMatchObject({ status: 'ready', exportId: started.body.data.exportId });
    expect(ready.body.data.url).toMatch(/^https?:\/\//);
  });

  test('my deletion request is shown; staff cannot request deletion here', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const A = h.bearer(acct.accessToken);
    expect((await request(app).get('/api/me/deletion-request').set(A)).body.data).toBeNull();
    await request(app).post('/api/me/deletion-request').set(A).send({ reason: 'Moving abroad' }).expect(201);
    expect((await request(app).get('/api/me/deletion-request').set(A)).body.data).toMatchObject({ status: 'requested', reason: 'Moving abroad' });
    const agent = await h.userWithToken('agent');
    expect((await request(app).get('/api/me/deletion-request').set(h.bearer(agent.token))).status).toBe(403);
  });

  test('notification preferences round trip per category and channel', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const A = h.bearer(acct.accessToken);
    const got = await request(app).get('/api/me/notification-preferences').set(A);
    expect(got.body.data.categories).toEqual(expect.arrayContaining(['leads', 'alerts', 'marketing']));
    await request(app).patch('/api/me/notification-preferences').set(A).send({ alerts: { email: false }, marketing: { sms: false, whatsapp: false } }).expect(200);
    const after = await request(app).get('/api/me/notification-preferences').set(A);
    expect(after.body.data.prefs).toMatchObject({ alerts: { email: false }, marketing: { sms: false, whatsapp: false } });
  });
});

describe('[M][admin] RE-S-ADM-22 deletion decisions', () => {
  test('in progress with a note, then completed anonymises the buyer', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const reqd = await request(app).post('/api/me/deletion-request').set(h.bearer(acct.accessToken)).send({});
    const id = reqd.body.data._id;
    const short = await request(app).patch(`/api/admin/deletion-requests/${id}`).set(S).send({ status: 'in_progress', note: 'ok' });
    expect(short.status).toBe(422);
    await request(app).patch(`/api/admin/deletion-requests/${id}`).set(S).send({ status: 'in_progress', note: 'Checking open deals' }).expect(200);
    const done = await request(app).patch(`/api/admin/deletion-requests/${id}`).set(S).send({ status: 'completed', note: 'No open deals, anonymised' });
    expect(done.body.data.status).toBe('completed');
    expect((await User.findById(acct.userId)).status).toBe('anonymised');
    const closed = await request(app).patch(`/api/admin/deletion-requests/${id}`).set(S).send({ status: 'rejected', note: 'Too late now' });
    expect(closed.body.error.code).toBe('REQUEST_CLOSED');
    expect(await DeletionRequest.countDocuments({ userId: acct.userId })).toBe(1);
  });
});
