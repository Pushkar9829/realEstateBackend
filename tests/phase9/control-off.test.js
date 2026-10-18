// Without CC_KEY_ID / CC_SECRET the Control Center adapter does not exist (decision B6).
const request = require('supertest');
const mongoose = require('mongoose');
const { setup } = require('../helpers');
const control = require('../../src/modules/control');

let app;
beforeAll(async () => { app = await setup(); });
afterAll(() => mongoose.disconnect());

test('[CC] adapter off: no /api/cc routes, no SSO, no gate', async () => {
  expect(control.enabled()).toBe(false);
  expect(await control.paused('hub_delivery')).toBe(false);
  expect((await request(app).get('/api/cc/health')).body.error.code).toBe('ROUTE_NOT_FOUND');
  expect((await request(app).get('/api/cc-status')).body.error.code).toBe('ROUTE_NOT_FOUND');
  expect((await request(app).post('/api/auth/cc-sso').send({ assertion: 'x' })).body.error.code).toBe('ROUTE_NOT_FOUND');
  expect(mongoose.connection.models.CcState).toBeUndefined();
});
