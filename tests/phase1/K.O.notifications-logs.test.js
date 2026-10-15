// Phase 1 (spec M1) - Module K Notifications and Module O audit / logs / health.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const { Notification } = require('../../src/modules/notifications/models');
const notifications = require('../../src/modules/notifications/service');
const { Job } = require('../../src/core/jobs');

let app; let admin; let acct;
beforeAll(async () => {
  app = await h.setup();
  admin = await h.userWithToken('superadmin');
  acct = await h.registerActive(app, 'buyer');
});
afterAll(() => mongoose.disconnect());

describe('[K][public] RE-K-04 Notification centre', () => {
  test('list, unread badge, mark one read, mark all read', async () => {
    const t = h.bearer(acct.accessToken);
    await notifications.notifyUser({ user: { _id: acct.userId, name: 'X' }, event: 'test.message', channels: ['in_app'] });
    const list = await request(app).get('/api/me/notifications').set(t);
    expect(list.body.data.length).toBeGreaterThanOrEqual(2); // welcome + test
    expect((await request(app).get('/api/me/notifications/unread-count').set(t)).body.data.count).toBeGreaterThanOrEqual(2);
    await request(app).patch(`/api/me/notifications/${list.body.data[0]._id}/read`).set(t).expect(200);
    await request(app).post('/api/me/notifications/read-all').set(t).expect(200);
    expect((await request(app).get('/api/me/notifications/unread-count').set(t)).body.data.count).toBe(0);
  });

  test('a user cannot read someone else\'s notification', async () => {
    const other = await h.registerActive(app, 'buyer');
    const mine = await Notification.findOne({ userId: acct.userId });
    expect((await request(app).patch(`/api/me/notifications/${mine._id}/read`).set(h.bearer(other.accessToken))).status).toBe(404);
  });

  test('preferences are validated per category and channel', async () => {
    const t = h.bearer(acct.accessToken);
    const ok = await request(app).patch('/api/me/notification-preferences').set(t).send({ alerts: { email: false } });
    expect(ok.body.data.alerts.email).toBe(false);
    expect((await request(app).patch('/api/me/notification-preferences').set(t).send({ alerts: { pigeon: true } })).status).toBe(422);
    expect((await request(app).get('/api/me/notification-preferences').set(t)).body.data.categories).toContain('leads');
  });
});

describe('[K][system] RE-K-01/07 Engine rules', () => {
  test('SMS is never queued for an international number', async () => {
    const before = await Job.countDocuments({ type: 'notify.sms' });
    await notifications.notifyUser({ user: { _id: new mongoose.Types.ObjectId(), name: 'NRI', phone: '+447700900123', email: 'nri@example.com' }, event: 'test.message', channels: ['sms', 'email'] });
    expect(await Job.countDocuments({ type: 'notify.sms' })).toBe(before);
  });

  test('quiet hours (21:00-08:00 IST) delay non-urgent SMS until 08:00', async () => {
    const at2230ist = new Date('2026-10-13T17:00:00Z'); // 22:30 IST
    const wait = await notifications.quietDelayMs(at2230ist);
    expect(wait).toBe((9 * 60 + 30) * 60000);
    expect(await notifications.quietDelayMs(new Date('2026-10-13T06:00:00Z'))).toBe(0); // 11:30 IST
  });
});

describe('[K][admin] RE-K-02 Templates', () => {
  test('list, override a template, send a test', async () => {
    const A = h.bearer(admin.token);
    const list = await request(app).get('/api/admin/notification-templates').set(A);
    expect(list.body.data.find((r) => r.key === 'auth.otp' && r.channel === 'sms')).toBeTruthy();
    const edit = await request(app).patch('/api/admin/notification-templates/auth.welcome/email').set(A).send({ subject: 'Hello {{name}}', body: 'Welcome aboard {{name}}' });
    expect(edit.body.data).toMatchObject({ key: 'auth.welcome', channel: 'email', subject: 'Hello {{name}}' });
    expect((await request(app).patch('/api/admin/notification-templates/nope/email').set(A).send({ body: 'x' })).status).toBe(404);
    const test = await request(app).post('/api/admin/notification-templates/test.message/in_app/test').set(A);
    expect(test.body.data.queued).toEqual(['in_app']);
  });
});

describe('[O][admin] RE-O-05 Audit and login history', () => {
  test('audit log is filterable and needs logs.view', async () => {
    const A = h.bearer(admin.token);
    await request(app).post('/api/admin/masters/cities').set(A).send({ name: 'Nagpur' });
    const res = await request(app).get('/api/admin/audit-logs?action=master.').set(A);
    expect(res.body.data[0]).toMatchObject({ action: 'master.create', actorRole: 'superadmin' });
    const staff = await h.userWithToken('admin', { permissions: ['dashboard.view'] });
    expect((await request(app).get('/api/admin/audit-logs').set(h.bearer(staff.token))).body.error.code).toBe('MISSING_PERMISSION');
  });

  test('login history across users with filters', async () => {
    const res = await request(app).get(`/api/admin/login-history?userId=${acct.userId}`).set(h.bearer(admin.token));
    expect(res.body.data[0]).toMatchObject({ success: true, userId: { email: acct.email } });
  });

  test('health answers with database status', async () => {
    expect((await request(app).get('/api/health')).body.data).toMatchObject({ status: 'ok', db: 'up' });
  });
});
