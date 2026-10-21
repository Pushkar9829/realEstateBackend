// Growth Hub -> Real Estate lead status webhooks (mlm-engine INTEGRATION_CONTRACT
// sections 8 and 10): OFF (404) by default, signature over the raw body with
// MLM_PLATFORM_SECRET, 300 s window, previous-secret header, dedupe on
// X-Hub-Delivery-Id, newest status wins, audit, staff see the hub status and a
// `hub` timeline entry while the platform's own stage and assignment stay as they are.
const crypto = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const env = require('../../src/config/env');
const { Lead, HubWebhook } = require('../../src/modules/leads/models');
const { AuditLog, SecurityEvent } = require('../../src/core/audit');
const svc = require('../../src/modules/leads/hubWebhook.service');

const SECRET = 'whsec_re_webhook_test_0001';
const URL = '/api/integrations/hub/webhooks';
const LEAD_NO = 'LD26-990001';
let app; let leadId;

beforeAll(async () => {
  app = await h.setup();
  const lead = await Lead.create({ leadNo: LEAD_NO, buyer: { name: 'Meera Shah', phone: '+919900112233' }, sources: ['enquiry'], stage: 'new', timeline: [{ type: 'created', data: { type: 'enquiry' } }] });
  leadId = lead._id;
});
afterAll(async () => { env.MLM_PLATFORM_SECRET = undefined; await mongoose.disconnect(); });

const now = () => String(Math.floor(Date.now() / 1000));
const hmac = (secret, ts, raw) => crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
const body = (type, data, extra = {}) => JSON.stringify({
  deliveryId: extra.deliveryId || `whd_${crypto.randomBytes(4).toString('hex')}`, type, schemaVersion: '1', platform: 'realestate',
  occurredAt: extra.occurredAt || new Date().toISOString(), ...(extra.test ? { test: true } : {}),
  data: { hubLeadId: '6712bb01', leadNo: 'LD-2610-00042', externalLeadId: LEAD_NO, ...data },
});
function send(raw, opts = {}) {
  const parsed = JSON.parse(raw);
  const ts = opts.ts || now();
  const r = request(app).post(URL).set('Content-Type', 'application/json')
    .set('X-Hub-Platform', 'realestate').set('X-Hub-Event', parsed.type).set('X-Hub-Delivery-Id', parsed.deliveryId).set('X-Hub-Timestamp', ts)
    .set('X-Hub-Signature', opts.sig || hmac(opts.secret || SECRET, ts, raw));
  if (opts.previous) r.set('X-Hub-Signature-Previous', opts.previous);
  return r.send(raw);
}
const lead = () => Lead.findById(leadId).lean();

describe('[C][integrations] Growth Hub lead status webhook', () => {
  test('disabled by default: 404 while MLM_PLATFORM_SECRET is unset, nothing stored', async () => {
    expect(env.MLM_PLATFORM_SECRET).toBeUndefined(); // tests/env.js sets no hub secret
    const res = await send(body('lead.status_changed', { status: 'contacted' }, { deliveryId: 'whd_off_01' }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('HUB_WEBHOOKS_DISABLED');
    expect(await HubWebhook.exists({ deliveryId: 'whd_off_01' })).toBeNull();
    expect((await lead()).hub).toBeUndefined();
  });

  test('contract vector 3 verifies with the reference algorithm', () => {
    const hook = '{"deliveryId":"whd_01","type":"lead.status_changed","occurredAt":"2026-10-18T10:05:00.000Z","platform":"lms","data":{"hubLeadId":"6712aa","leadNo":"LD-2610-00001","externalLeadId":"lms-enq-1","stage":"contacted","status":"contacted","previousStage":"new","previousStatus":"new"}}';
    const headers = { 'x-hub-timestamp': '1791878400', 'x-hub-signature': '4695e2054bf51d5427adab782266836517893eccde3b46d4b81c4f40e32291d1' };
    const realNow = Date.now;
    Date.now = () => 1791878400 * 1000;
    try {
      expect(svc.verify(hook, headers, 'whsec_test_contract_vector_0001')).toBe(true);
      expect(svc.verify(hook.replace('contacted', 'lost'), headers, 'whsec_test_contract_vector_0001')).toBe(false);
    } finally { Date.now = realNow; }
  });

  describe('enabled (MLM_PLATFORM_SECRET set)', () => {
    beforeAll(() => { env.MLM_PLATFORM_SECRET = SECRET; });

    test('valid accepted / assigned / status_changed update lead.hub, add hub timeline entries and audit; own stage untouched', async () => {
      const t0 = Date.now();
      const a = await send(body('lead.accepted', { stage: 'new', status: 'new', outcome: 'created' }, { occurredAt: new Date(t0 - 3000).toISOString() }));
      expect(a.status).toBe(200);
      expect(a.body.data).toMatchObject({ received: true, duplicate: false, result: 'processed' });
      expect((await send(body('lead.assigned', { stage: 'new', status: 'new', ownerDisplayName: 'Neha S.' }, { occurredAt: new Date(t0 - 2000).toISOString() }))).body.data.result).toBe('processed');
      const c = await send(body('lead.status_changed', { stage: 'contacted', stageLabel: 'Contacted', status: 'contacted', previousStatus: 'new', ownerDisplayName: 'Neha S.' }, { occurredAt: new Date(t0 - 1000).toISOString() }));
      expect(c.body.data.result).toBe('processed');
      const l = await lead();
      expect(l.stage).toBe('new');
      expect(l.assignedTo).toBeUndefined();
      expect(l.hub).toMatchObject({ hubLeadId: '6712bb01', leadNo: 'LD-2610-00042', status: 'contacted', stageLabel: 'Contacted', ownerDisplayName: 'Neha S.', outcome: 'created', lastEvent: 'lead.status_changed' });
      const hubEntries = l.timeline.filter((e) => e.type === 'hub');
      expect(hubEntries.map((e) => e.data.event)).toEqual(['lead.accepted', 'lead.assigned', 'lead.status_changed']);
      expect(hubEntries[2].data).toMatchObject({ status: 'contacted', stageLabel: 'Contacted', owner: 'Neha S.' });
      const log = await AuditLog.findOne({ action: 'lead.hub_status', entityId: leadId }).sort({ at: -1, _id: -1 }).lean();
      expect(log).toMatchObject({ actorRole: 'system', after: { hubStatus: 'contacted', event: 'lead.status_changed' } });
    });

    test('staff see the hub status in the admin lead detail', async () => {
      const su = await h.userWithToken('superadmin');
      const res = await request(app).get(`/api/admin/leads/${leadId}`).set(h.bearer(su.token));
      expect(res.status).toBe(200);
      expect(res.body.data.hub).toMatchObject({ status: 'contacted', stageLabel: 'Contacted', ownerDisplayName: 'Neha S.', leadNo: 'LD-2610-00042' });
      expect(res.body.data.timeline.some((e) => e.type === 'hub' && e.data.event === 'lead.status_changed')).toBe(true);
    });

    test('an older delivery is ignored; lead.converted is stored with the conversion', async () => {
      const old = await send(body('lead.status_changed', { stage: 'new', status: 'new' }, { occurredAt: new Date(Date.now() - 3600000).toISOString() }));
      expect(old.status).toBe(200);
      expect(old.body.data.result).toBe('ignored');
      const conv = await send(body('lead.converted', { stage: 'won', status: 'converted', conversion: { type: 'buyer', refId: 'DL26-00412', at: new Date().toISOString(), source: 'event' } }));
      expect(conv.body.data.result).toBe('processed');
      const l = await lead();
      expect(l.hub).toMatchObject({ status: 'converted', lastEvent: 'lead.converted', conversion: { type: 'buyer', refId: 'DL26-00412' } });
      expect(l.stage).toBe('new');
    });

    test('a duplicate delivery id answers 200 and changes nothing', async () => {
      const raw = body('lead.status_changed', { stage: 'lost', status: 'lost', lostReason: 'budget' }, { deliveryId: 'whd_dup_01' });
      expect((await send(raw)).body.data.duplicate).toBe(false);
      const before = await lead();
      const again = await send(raw);
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({ received: true, duplicate: true });
      expect((await lead()).timeline).toHaveLength(before.timeline.length);
      expect(await HubWebhook.countDocuments({ deliveryId: 'whd_dup_01' })).toBe(1);
    });

    test('a bad signature answers 401, stores nothing and records a security event', async () => {
      const raw = body('lead.status_changed', { status: 'junk' }, { deliveryId: 'whd_bad_01' });
      const res = await send(raw, { secret: 'wrong-secret' });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SIGNATURE_INVALID');
      const ts = now();
      expect((await send(raw.replace('junk', 'lost'), { ts, sig: hmac(SECRET, ts, raw) })).status).toBe(401);
      expect(await HubWebhook.exists({ deliveryId: 'whd_bad_01' })).toBeNull();
      expect(await SecurityEvent.exists({ type: 'webhook.rejected', 'meta.provider': 'hub' })).toBeTruthy();
    });

    test('a stale or future timestamp is refused even with a correct signature', async () => {
      const raw = body('lead.status_changed', { status: 'contacted' }, { deliveryId: 'whd_stale_01' });
      expect((await send(raw, { ts: String(Math.floor(Date.now() / 1000) - 301) })).status).toBe(401);
      expect((await send(raw, { ts: String(Math.floor(Date.now() / 1000) + 301) })).status).toBe(401);
      expect(await HubWebhook.exists({ deliveryId: 'whd_stale_01' })).toBeNull();
    });

    test('rotation header accepted; hub "Send test" and unknown leads are acknowledged and ignored', async () => {
      const raw = body('lead.status_changed', { status: 'contacted' }, { test: true });
      const ts = now();
      const res = await send(raw, { ts, sig: 'f'.repeat(64), previous: hmac(SECRET, ts, raw) });
      expect(res.status).toBe(200);
      expect(res.body.data.result).toBe('ignored');
      const unknown = await send(body('lead.status_changed', { externalLeadId: 'LD26-000000', status: 'contacted' }));
      expect(unknown.status).toBe(200);
      expect(unknown.body.data.result).toBe('ignored');
    });
  });
});
