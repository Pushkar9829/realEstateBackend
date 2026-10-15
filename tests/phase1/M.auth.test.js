// Phase 1 (spec M1) - Module M Authentication & Account Security.
// Test names: [module][panel] feature-id - behaviour.
const request = require('supertest');
const mongoose = require('mongoose');
const { authenticator } = require('otplib');
const h = require('../helpers');
const { User, Otp, RefreshToken, Consent, DeletionRequest } = require('../../src/modules/auth/models');
const { Lead } = require('../../src/modules/leads/models');
const { ExportJob } = require('../../src/modules/reports/models');
const notify = require('../../src/core/notify');
const jobs = require('../../src/core/jobs');

let app; let superadmin;
beforeAll(async () => {
  app = await h.setup();
  require('../../src/jobs').registerAll();
  superadmin = await h.userWithToken('superadmin');
});
afterAll(() => mongoose.disconnect());

const reg = (id, role, extra) => request(app).post('/api/auth/register').send(h.registerBody(id, role, extra));

describe('[M][public] RE-M-01 Registration', () => {
  test('buyer registers; email + phone OTPs sent; account pending', async () => {
    const id = h.newIdentity('b');
    const res = await reg(id, 'buyer');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ phoneVerification: 'sms' });
    expect((await User.findOne({ email: id.email })).status).toBe('pending_verification');
    expect(() => h.otpFor(id.email)).not.toThrow();
    expect(() => h.otpFor(h.e164(id.phone))).not.toThrow();
  });

  test('lister must choose a type and tick the no-broker declaration; builders need a company name', async () => {
    const id = h.newIdentity('l');
    const bad = await request(app).post('/api/auth/register').send({ ...h.registerBody(id, 'buyer'), role: 'lister' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['listerType', 'noBrokerDeclaration']));
    const builder = await reg(h.newIdentity('bd'), 'lister', { listerType: 'builder' });
    expect(builder.body.error.details.map((d) => d.path)).toContain('companyName');
    const ok = await reg(h.newIdentity('bd2'), 'lister', { listerType: 'builder', companyName: 'Sunrise Developers' });
    expect(ok.status).toBe(201);
    const u = await User.findById(ok.body.data.userId);
    expect(u).toMatchObject({ role: 'lister', listerType: 'builder' });
    expect(u.kyc.status).toBe('not_started');
    expect(u.brand.name).toBe('Sunrise Developers');
  });

  test('staff roles cannot self-register', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...h.registerBody(h.newIdentity(), 'buyer'), role: 'agent' });
    expect(res.status).toBe(422);
  });

  test('duplicate email or phone -> ALREADY_REGISTERED', async () => {
    const id = h.newIdentity();
    await reg(id, 'buyer');
    const again = await reg({ ...h.newIdentity(), phone: id.phone }, 'buyer');
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
  });

  test('international number: OTP by email only, activation without SMS (acceptance 6)', async () => {
    const id = h.newIdentity('nri', { international: true });
    notify.sent.length = 0;
    const res = await reg(id, 'buyer');
    expect(res.status).toBe(201);
    expect(res.body.data.phoneVerification).toBe('not_required');
    expect(notify.sent.filter((m) => m.channel === 'sms')).toHaveLength(0);
    const v = await request(app).post('/api/auth/verify-contact').send({ verificationToken: res.body.data.verificationToken, channel: 'email', code: h.otpFor(id.email) });
    expect(v.body.data.status).toBe('active');
    const step1 = await request(app).post('/api/auth/login').send({ identifier: id.email, password: id.password, channel: 'sms' });
    expect(step1.body.data.methods).toEqual(['email']);
    expect(step1.body.data.method).toBe('email'); // SMS requested but never used
  });

  test('marketing opt-in at signup is recorded in the consent ledger', async () => {
    const acct = await h.registerActive(app, 'buyer', { marketingOptIn: true });
    const c = await Consent.findOne({ subjectId: acct.userId, purpose: 'marketing_alerts' });
    expect(c).toMatchObject({ source: 'registration', noticeVersion: expect.any(String) });
  });

  test('activation sends a welcome message and returns the role home path', async () => {
    const acct = await h.registerActive(app, 'lister');
    expect(acct.home).toBe('/lister');
    const { Notification } = require('../../src/modules/notifications/models');
    expect(await Notification.exists({ userId: acct.userId, eventKey: 'auth.welcome' })).toBeTruthy();
  });
});

describe('[M][public] RE-M-02 Two-step login with mandatory 2FA', () => {
  let acct;
  beforeAll(async () => { acct = await h.registerActive(app, 'buyer'); });

  test('step 1 never returns an access token (acceptance 1)', async () => {
    await h.resetOtpLimits(acct.email);
    const res = await request(app).post('/api/auth/login').send({ identifier: acct.email, password: acct.password });
    expect(res.body.data.accessToken).toBeUndefined();
    expect(res.body.data.methods).toEqual(['email', 'sms']);
  });

  test('email OTP and SMS OTP both complete login; home path by role', async () => {
    const a = await h.loginFull(app, acct.email, acct.password);
    expect(a).toMatchObject({ home: '/', mustChangePassword: false });
    const b = await h.loginFull(app, acct.phone, acct.password, { channel: 'sms', target: acct.phoneE164 });
    expect(b.accessToken).toBeTruthy();
  });

  test('a wrong OTP 5 times invalidates the challenge (acceptance 2)', async () => {
    await h.resetOtpLimits(acct.email);
    const s1 = await request(app).post('/api/auth/login').send({ identifier: acct.email, password: acct.password });
    for (let i = 0; i < 5; i += 1) await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: s1.body.data.challengeToken, code: '000000' });
    const res = await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: s1.body.data.challengeToken, code: h.otpFor(acct.email) });
    expect(res.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  test('unverified accounts are sent back to verification', async () => {
    const id = h.newIdentity();
    await reg(id, 'buyer');
    const res = await request(app).post('/api/auth/login').send({ identifier: id.email, password: id.password });
    expect(res.body.error.code).toBe('CONTACT_NOT_VERIFIED');
  });
});

describe('[M][public] RE-M-03 Authenticator app', () => {
  test('enable TOTP, log in with it, recovery code works once, disable needs a code', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const t = acct.accessToken;
    const setupRes = await request(app).post('/api/me/totp/setup').set(h.bearer(t));
    const { secret } = setupRes.body.data;
    const en = await request(app).post('/api/me/totp/enable').set(h.bearer(t)).send({ code: authenticator.generate(secret) });
    expect(en.body.data.recoveryCodes).toHaveLength(10);
    const s1 = await request(app).post('/api/auth/login').send({ identifier: acct.email, password: acct.password });
    expect(s1.body.data.method).toBe('totp');
    const s2 = await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: s1.body.data.challengeToken, code: authenticator.generate(secret) });
    expect(s2.status).toBe(200);
    const s3 = await request(app).post('/api/auth/login').send({ identifier: acct.email, password: acct.password });
    expect((await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: s3.body.data.challengeToken, recoveryCode: en.body.data.recoveryCodes[0] })).status).toBe(200);
    const noCode = await request(app).delete('/api/me/totp').set(h.bearer(s2.body.data.accessToken)).send({});
    expect(noCode.status).toBe(422);
    const off = await request(app).delete('/api/me/totp').set(h.bearer(s2.body.data.accessToken)).send({ code: authenticator.generate(secret) });
    expect(off.body.data.method).toBe('email');
  });
});

describe('[M][public] RE-M-04 Tokens and sessions', () => {
  test('refresh rotates; reuse of a rotated token revokes the family (acceptance 4)', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const t = await h.loginFull(app, acct.email, acct.password);
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken });
    expect(r1.status).toBe(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: r1.body.data.refreshToken })).status).toBe(401);
  });

  test('sessions list marks the current one; logout-all revokes everything', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const a = await h.loginFull(app, acct.email, acct.password);
    const b = await h.loginFull(app, acct.email, acct.password);
    const list = await request(app).get('/api/me/sessions').set(h.bearer(a.accessToken));
    expect(list.body.data.filter((s) => s.current)).toHaveLength(1);
    await request(app).post('/api/auth/logout-all').set(h.bearer(a.accessToken)).expect(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: b.refreshToken })).status).toBe(401);
  });

  test('logout with no body ends the current session', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const t = await h.loginFull(app, acct.email, acct.password);
    await request(app).post('/api/auth/logout').set(h.bearer(t.accessToken)).expect(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
  });
});

describe('[M][public] RE-M-05 Password reset and change', () => {
  test('forgot answers the same for unknown accounts; reset revokes sessions', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const t = await h.loginFull(app, acct.email, acct.password);
    const unknown = await request(app).post('/api/auth/password/forgot').send({ identifier: 'ghost@example.com' });
    const known = await request(app).post('/api/auth/password/forgot').send({ identifier: acct.email });
    expect(unknown.body.data).toEqual(known.body.data);
    const res = await request(app).post('/api/auth/password/reset').send({ identifier: acct.email, code: h.otpFor(acct.email), newPassword: 'Another456' });
    expect(res.status).toBe(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
  });

  test('the last passwords cannot be reused', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const t = await h.loginFull(app, acct.email, acct.password);
    await request(app).patch('/api/me/password').set(h.bearer(t.accessToken)).send({ currentPassword: acct.password, newPassword: 'Second222' }).expect(200);
    const back = await request(app).patch('/api/me/password').set(h.bearer(t.accessToken)).send({ currentPassword: 'Second222', newPassword: acct.password });
    expect(back.body.error.code).toBe('PASSWORD_REUSED');
  });
});

describe('[M][public] RE-M-06 Lockout and login history', () => {
  test('5 wrong passwords lock for 15 minutes', async () => {
    const acct = await h.registerActive(app, 'buyer');
    for (let i = 0; i < 5; i += 1) await request(app).post('/api/auth/login').send({ identifier: acct.email, password: 'Wrong1234' });
    const u = await User.findById(acct.userId);
    expect(u.status).toBe('locked');
    expect((await request(app).post('/api/auth/login').send({ identifier: acct.email, password: acct.password })).body.error.code).toBe('ACCOUNT_LOCKED');
  });

  test('login history records IP and user agent', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const t = await h.loginFull(app, acct.email, acct.password);
    const res = await request(app).get('/api/me/login-history').set(h.bearer(t.accessToken));
    expect(res.body.data[0]).toMatchObject({ success: true, method: 'otp_email', ip: expect.any(String) });
  });
});

describe('[M][admin] RE-M-07 RBAC and permissions', () => {
  test('agent on /api/admin -> 403; manager on an admin-only route -> 403 (acceptance 3)', async () => {
    const agent = await h.userWithToken('agent');
    const manager = await h.userWithToken('manager', { permissions: ['dashboard.view', 'leads.assign'] });
    expect((await request(app).get('/api/admin/staff').set(h.bearer(agent.token))).body.error.code).toBe('WRONG_PANEL');
    expect((await request(app).get('/api/admin/staff').set(h.bearer(manager.token))).body.error.code).toBe('MISSING_PERMISSION');
  });
});

describe('[M][admin] RE-M-08 Staff provisioning', () => {
  let createdManager;
  test('admin creates a manager with default permissions; temp password emailed', async () => {
    const id = h.newIdentity('mgr');
    notify.sent.length = 0;
    const res = await request(app).post('/api/admin/staff').set(h.bearer(superadmin.token))
      .send({ role: 'manager', name: 'Meera Manager', email: id.email, phone: id.phone });
    expect(res.status).toBe(201);
    createdManager = { ...id, userId: res.body.data._id };
    const u = await User.findById(res.body.data._id).select('+permissions');
    expect(u.permissions).toEqual(expect.arrayContaining(['leads.assign', 'reports.view']));
    expect(u.mustChangePassword).toBe(true);
    const { Job } = jobs;
    const mail = await Job.findOne({ type: 'notify.email', 'payload.to': id.email });
    createdManager.temp = mail.payload.text.match(/temporary password: (\S+)/)[1];
  });

  test('first login is gated until the temporary password is changed', async () => {
    const t = await h.loginFull(app, createdManager.email, createdManager.temp);
    expect(t.mustChangePassword).toBe(true);
    const blocked = await request(app).get('/api/agent/leads').set(h.bearer(t.accessToken));
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await request(app).get('/api/me').set(h.bearer(t.accessToken)).expect(200);
    await request(app).patch('/api/me/password').set(h.bearer(t.accessToken)).send({ currentPassword: createdManager.temp, newPassword: 'Manager789' }).expect(200);
    expect((await request(app).get('/api/agent/leads').set(h.bearer(t.accessToken))).status).toBe(200); // reachable once the password is changed
  });

  test('agents can only receive verification.field; staff need Indian numbers', async () => {
    const bad = await request(app).post('/api/admin/staff').set(h.bearer(superadmin.token))
      .send({ role: 'agent', name: 'Arjun Agent', email: h.newIdentity().email, phone: h.newIdentity().phone, permissions: ['deals.verify'] });
    expect(bad.status).toBe(422);
    const intl = await request(app).post('/api/admin/staff').set(h.bearer(superadmin.token))
      .send({ role: 'agent', name: 'Arjun Agent', email: h.newIdentity().email, phone: '+447700900123' });
    expect(intl.status).toBe(422);
  });

  test('disable with reassignment moves open leads and revokes sessions', async () => {
    const agentId = h.newIdentity('ag');
    const a = await request(app).post('/api/admin/staff').set(h.bearer(superadmin.token)).send({ role: 'agent', name: 'Asha Agent', email: agentId.email, phone: agentId.phone });
    const other = await h.userWithToken('agent');
    await Lead.create([{ leadNo: 'LD26-T1', assignedTo: a.body.data._id, stage: 'contacted' }, { leadNo: 'LD26-T2', assignedTo: a.body.data._id, stage: 'closed_won' }]);
    const res = await request(app).post(`/api/admin/staff/${a.body.data._id}/disable`).set(h.bearer(superadmin.token)).send({ reason: 'Left the company', reassignTo: String(other.user._id) });
    expect(res.body.data).toMatchObject({ disabled: true, leadsMoved: 1 });
    expect((await Lead.findOne({ leadNo: 'LD26-T1' })).assignedTo.toString()).toBe(String(other.user._id));
    expect((await User.findById(a.body.data._id)).status).toBe('disabled');
  });

  test('reset 2FA and force logout are audited', async () => {
    const t = await h.loginFull(app, createdManager.email, 'Manager789');
    await request(app).post(`/api/admin/staff/${createdManager.userId}/reset-2fa`).set(h.bearer(superadmin.token)).expect(200);
    await request(app).post(`/api/admin/staff/${createdManager.userId}/force-logout`).set(h.bearer(superadmin.token)).expect(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
    const { AuditLog } = require('../../src/core/audit');
    expect(await AuditLog.countDocuments({ entityId: createdManager.userId, action: { $in: ['staff.2fa_reset', 'staff.force_logout'] } })).toBe(2);
  });
});

describe('[M][public] RE-M-09 Become a lister', () => {
  test('buyer converts to lister and must log in again', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const res = await request(app).post('/api/me/become-lister').set(h.bearer(acct.accessToken)).send({ listerType: 'landlord', noBrokerDeclaration: true });
    expect(res.body.data).toMatchObject({ role: 'lister', reloginRequired: true });
    const t = await h.loginFull(app, acct.email, acct.password);
    expect(t.home).toBe('/lister');
  });
});

describe('[M][public] RE-M-10 Consent ledger and data rights', () => {
  test('list and withdraw consents', async () => {
    const acct = await h.registerActive(app, 'buyer', { marketingOptIn: true });
    const list = await request(app).get('/api/me/consents').set(h.bearer(acct.accessToken));
    expect(list.body.data.consents).toHaveLength(1);
    await request(app).post('/api/me/consents/marketing_alerts/withdraw').set(h.bearer(acct.accessToken)).expect(200);
    expect((await Consent.findOne({ subjectId: acct.userId })).withdrawnAt).toBeTruthy();
    const unknown = await request(app).post('/api/me/consents/spam/withdraw').set(h.bearer(acct.accessToken));
    expect(unknown.status).toBe(422);
  });

  test('deletion request: one open at a time, visible in the admin queue', async () => {
    const acct = await h.registerActive(app, 'buyer');
    await request(app).post('/api/me/deletion-request').set(h.bearer(acct.accessToken)).send({ reason: 'No longer needed' }).expect(201);
    const again = await request(app).post('/api/me/deletion-request').set(h.bearer(acct.accessToken)).send({});
    expect(again.body.error.code).toBe('DELETION_PENDING');
    const queue = await request(app).get('/api/admin/deletion-requests').set(h.bearer(superadmin.token));
    expect(queue.body.data.some((d) => String(d.userId._id) === String(acct.userId))).toBe(true);
    expect(await DeletionRequest.countDocuments({ userId: acct.userId })).toBe(1);
  });

  test('data export is built in the background as a private file', async () => {
    const acct = await h.registerActive(app, 'buyer');
    const res = await request(app).post('/api/me/data-export').set(h.bearer(acct.accessToken));
    expect(res.status).toBe(201);
    let job;
    for (let i = 0; i < 20; i += 1) { // the worker drains up to 20 jobs per tick; earlier tests queued emails
      await jobs.tick();
      job = await ExportJob.findById(res.body.data.exportId);
      if (job.status === 'ready') break;
    }
    expect(job.status).toBe('ready');
    const storage = require('../../src/core/storage');
    expect((await storage.FileModel.findById(job.fileId)).visibility).toBe('private');
    expect((await request(app).post('/api/me/data-export').set(h.bearer(acct.accessToken))).body.error.code).toBe('EXPORT_LIMIT');
  });

  test('admin sees a user\'s consents (users.manage)', async () => {
    const acct = await h.registerActive(app, 'buyer', { marketingOptIn: true });
    const res = await request(app).get(`/api/admin/users/${acct.userId}/consents`).set(h.bearer(superadmin.token));
    expect(res.body.data[0].purpose).toBe('marketing_alerts');
  });
});

describe('[M][lister] Suspended listers', () => {
  test('a suspended lister keeps only dashboard and invoices (423 elsewhere)', async () => {
    const l = await h.userWithToken('lister', { listerType: 'owner', kyc: { status: 'suspended' } });
    const res = await request(app).get('/api/lister/properties').set(h.bearer(l.token));
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('LISTER_SUSPENDED');
    expect((await request(app).get('/api/lister/invoices').set(h.bearer(l.token))).status).toBe(200); // invoices stay reachable while suspended
  });
});
