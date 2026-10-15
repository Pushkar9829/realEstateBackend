// Architecture tests: every endpoint designed in docs/SPEC.md is mounted on the
// right panel with the right guard, and unbuilt endpoints answer 501.
const request = require('supertest');
const mongoose = require('mongoose');
const { setup, userWithToken, bearer } = require('./helpers');
const listRoutes = require('../src/core/http/listRoutes');

let app;
const t = {};

beforeAll(async () => {
  app = await setup();
  t.superadmin = (await userWithToken('superadmin')).token;
  t.buyer = (await userWithToken('buyer')).token;
  t.owner = (await userWithToken('lister', { listerType: 'owner' })).token;
  t.builder = (await userWithToken('lister', { listerType: 'builder' })).token;
  t.agent = (await userWithToken('agent', { permissions: ['verification.field'] })).token;
  t.manager = (await userWithToken('manager', { permissions: ['dashboard.view', 'leads.view_all', 'leads.assign', 'reports.view'] })).token;
  t.staffNoPerms = (await userWithToken('admin', { permissions: ['dashboard.view'] })).token;
});
afterAll(() => mongoose.disconnect());

const PARAMS = { slug: 'sample-slug', step: '1', tab: 'details', key: 'listings', token: 'x'.repeat(40), city: 'pune', locality: 'baner', version: '1', code: 'REF123' };
const fill = (p) => p.replace(/:(\w+)/g, (m, name) => PARAMS[name] || new mongoose.Types.ObjectId().toString());
const tokenFor = { public: 'buyer', integrations: null, lister: 'builder', agent: 'agent', admin: 'superadmin' };

describe('route map', () => {
  const routes = listRoutes();

  test('the full designed API surface is mounted on all five panels', () => {
    expect(routes.length).toBeGreaterThanOrEqual(340);
    expect(new Set(routes.map((r) => r.panel))).toEqual(new Set(['integrations', 'public', 'lister', 'agent', 'admin']));
    expect(new Set(routes.map((r) => r.module.split(' ')[0])).size).toBeGreaterThanOrEqual(15);
  });

  test('no duplicate method + path', () => {
    const seen = new Set();
    const dupes = routes.filter((r) => { const k = `${r.method} ${r.path}`; const d = seen.has(k); seen.add(k); return d; });
    expect(dupes).toEqual([]);
  });

  test('every endpoint is reachable with a suitable account (never ROUTE_NOT_FOUND)', async () => {
    const missing = [];
    for (const r of routes) {
      const role = tokenFor[r.panel];
      const req = request(app)[r.method.toLowerCase()](fill(r.path));
      if (role) req.set(bearer(t[role]));
      const res = await req.send({});
      if (res.body && res.body.error && res.body.error.code === 'ROUTE_NOT_FOUND') missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
  }, 180000);
});

describe('panel and role guards', () => {
  test('lister panel needs a token, and a lister account', async () => {
    expect((await request(app).get('/api/lister/properties')).status).toBe(401);
    const res = await request(app).get('/api/lister/properties').set(bearer(t.buyer));
    expect(res.body.error.code).toBe('WRONG_PANEL');
  });

  test('builder projects are builder-only', async () => {
    const owner = await request(app).get('/api/lister/projects').set(bearer(t.owner));
    expect(owner.body.error.code).toBe('BUILDERS_ONLY');
    const builder = await request(app).get('/api/lister/projects').set(bearer(t.builder));
    expect(builder.status).toBe(200); // guard passed (implemented in Phase 2)
  });

  test('agents and managers use the agent panel; listers do not', async () => {
    expect((await request(app).get('/api/agent/leads').set(bearer(t.agent))).status).toBe(200); // guard passed (built in Phase 4)
    expect((await request(app).get('/api/agent/leads').set(bearer(t.manager))).status).toBe(200);
    expect((await request(app).get('/api/agent/leads').set(bearer(t.owner))).body.error.code).toBe('WRONG_PANEL');
  });

  test('managers reach "manager, admin" routes but not admin-only ones', async () => {
    const reports = await request(app).get('/api/admin/reports/listings').set(bearer(t.manager));
    expect(reports.status).toBe(200); // manager, admin (reports.view), built in Phase 6
    const adminOnly = await request(app).get('/api/admin/properties').set(bearer(t.manager));
    expect(adminOnly.status).toBe(403);
  });

  test('admin staff need the permission key', async () => {
    const res = await request(app).post(`/api/admin/properties/${new mongoose.Types.ObjectId()}/claim`).set(bearer(t.staffNoPerms));
    expect(res.body.error.code).toBe('MISSING_PERMISSION');
    const ok = await request(app).post(`/api/admin/properties/${new mongoose.Types.ObjectId()}/claim`).set(bearer(t.superadmin));
    expect(ok.status).toBe(404); // guard passed; unknown id (implemented in Phase 2)
  });

  test('agent routes with a permission key check it', async () => {
    const res = await request(app).get('/api/agent/verification-visits').set(bearer(t.manager));
    expect(res.body.error.code).toBe('MISSING_PERMISSION');
    expect((await request(app).get('/api/agent/verification-visits').set(bearer(t.agent))).status).toBe(200);
  });

  test('public endpoints need no login; buyer endpoints do', async () => {
    expect((await request(app).get('/api/properties/some-slug')).status).toBe(404); // no login needed; unknown slug
    expect((await request(app).get('/api/me/enquiries')).status).toBe(401);
  });

  test('stub handlers answer 501 with the standard envelope and feature tag', async () => {
    const express = require('express');
    const stubs = require('../src/core/http/stubs');
    const { errorHandler } = require('../src/core/middleware/errors');
    const mini = express();
    mini.get('/x', stubs('B', ['demo']).demo);
    mini.use(errorHandler);
    const res = await request(mini).get('/x');
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_IMPLEMENTED' } });
    expect(res.body.error.message).toMatch(/RE-B:demo/);
  });

  test('every designed endpoint is implemented (no 501 stubs left)', () => {
    const listRoutes = require('../src/core/http/listRoutes');
    const left = listRoutes().filter((r) => !r.implemented).map((r) => `${r.method} ${r.path}`);
    expect(left).toEqual([]);
  });
});

describe('infrastructure', () => {
  test('health reports database up', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.data).toMatchObject({ status: 'ok', db: 'up' });
  });

  test('uploads: listers may upload ownership proof (private); buyers may not', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%test\n');
    const ok = await request(app).post('/api/uploads?purpose=ownership_proof').set(bearer(t.owner))
      .attach('file', pdf, { filename: 'deed.pdf', contentType: 'application/pdf' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.visibility).toBe('private');
    const denied = await request(app).post('/api/uploads?purpose=ownership_proof').set(bearer(t.buyer))
      .attach('file', pdf, { filename: 'deed.pdf', contentType: 'application/pdf' });
    expect(denied.status).toBe(403);
  });

  test('unknown routes return ROUTE_NOT_FOUND', async () => {
    expect((await request(app).get('/api/nope')).body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});
