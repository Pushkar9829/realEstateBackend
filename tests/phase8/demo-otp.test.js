// DEMO_OTP_CODE (demo / client-preview deployments): every emailed or SMS
// one-time code is the fixed value, so testers can log in without a provider.
process.env.DEMO_OTP_CODE = '123456';
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');

let app;
beforeAll(async () => { app = await h.setup(); });
afterAll(() => mongoose.disconnect());

describe('[S][public] Demo deployments: fixed one-time code', () => {
  test('registration and login both accept 123456; a wrong code is still refused', async () => {
    const id = h.newIdentity('demo');
    const reg = await request(app).post('/api/auth/register').send(h.registerBody(id, 'buyer')).expect(201);
    const { verificationToken } = reg.body.data;
    await request(app).post('/api/auth/verify-contact').send({ verificationToken, channel: 'email', code: '123456' }).expect(200);
    const done = await request(app).post('/api/auth/verify-contact').send({ verificationToken, channel: 'sms', code: '123456' }).expect(200);
    expect(done.body.data.accessToken).toBeTruthy();

    await h.resetOtpLimits(id.email);
    const step1 = await request(app).post('/api/auth/login').send({ identifier: id.email, password: id.password, channel: 'email' }).expect(200);
    const wrong = await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: step1.body.data.challengeToken, code: '654321' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const ok = await request(app).post('/api/auth/login/verify-2fa').send({ challengeToken: step1.body.data.challengeToken, code: '123456' }).expect(200);
    expect(ok.body.data.accessToken).toBeTruthy();
  });
});
