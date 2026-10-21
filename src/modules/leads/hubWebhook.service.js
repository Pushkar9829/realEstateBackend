// Module C - Growth Hub -> Real Estate lead status webhooks
// (mlm-engine/docs/INTEGRATION_CONTRACT.md section 8, verifier from section 10).
//
//   POST /api/integrations/hub/webhooks   raw JSON body
//   X-Hub-Platform, X-Hub-Event, X-Hub-Delivery-Id, X-Hub-Timestamp,
//   X-Hub-Signature = hex HMAC-SHA256(MLM_PLATFORM_SECRET, X-Hub-Timestamp + "." + rawBody)
//   X-Hub-Signature-Previous (rotation grace window only)
//
// Completely OFF (404) unless MLM_PLATFORM_SECRET is set (the secret the outbox
// already signs with). Timestamps outside 300 s and bad signatures answer 401
// (security event, nothing stored). A repeated delivery id answers 200 and
// changes nothing. The hub status is stored next to the lead (lead.hub) with a
// `hub` timeline entry for staff; the platform's own stage, assignment and SLA
// are never changed by the hub. The work is one small update done before the
// answer (well inside the hub's 10 s limit); if it fails the delivery row is
// removed and the 500 makes the hub retry.
const crypto = require('crypto');
const env = require('../../config/env');
const { ApiError } = require('../../core/http');
const { audit, securityEvent } = require('../../core/audit');
const { hmacSha256 } = require('../../core/security/crypto');
const { Lead, HubWebhook } = require('./models');

const WINDOW_SEC = 300;
const LEAD_EVENTS = ['lead.accepted', 'lead.assigned', 'lead.status_changed', 'lead.converted'];
const HUB_FIELDS = ['hubLeadId', 'leadNo', 'stage', 'stageLabel', 'status', 'ownerDisplayName', 'nextFollowUpAt', 'lostReason', 'conversion', 'outcome', 'mergedIntoLeadNo'];

const secret = () => env.MLM_PLATFORM_SECRET;
const enabled = () => Boolean(secret());

function verify(raw, headers, key = secret()) {
  const ts = headers['x-hub-timestamp'];
  if (!key || !ts || !/^\d{9,11}$/.test(String(ts)) || Math.abs(Date.now() / 1000 - Number(ts)) > WINDOW_SEC) return false;
  const expected = hmacSha256(key, `${ts}.${raw}`);
  return [headers['x-hub-signature'], headers['x-hub-signature-previous']].filter((s) => typeof s === 'string')
    .some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

async function apply(body, deliveryId) {
  const d = body.data || {};
  if (!LEAD_EVENTS.includes(body.type)) return { result: 'ignored', note: 'event type not handled' };
  if (body.test) return { result: 'ignored', note: 'test delivery' };
  if (!d.externalLeadId) return { result: 'ignored', note: 'no externalLeadId' };
  const lead = await Lead.findOne({ leadNo: String(d.externalLeadId) }).select('hub').lean();
  if (!lead) return { result: 'ignored', note: 'no matching lead' };
  const occurredAt = new Date(body.occurredAt || Date.now());
  // Delivery order is best-effort: keep only the newest status.
  if (lead.hub && lead.hub.occurredAt && new Date(lead.hub.occurredAt) > occurredAt) return { result: 'ignored', note: 'older than the stored status' };

  const set = { 'hub.lastEvent': body.type, 'hub.occurredAt': occurredAt, 'hub.receivedAt': new Date() };
  HUB_FIELDS.forEach((k) => { if (d[k] !== undefined) set[`hub.${k}`] = d[k]; });
  const entry = { type: 'hub', at: new Date(), data: { event: body.type, status: d.status, stage: d.stage, stageLabel: d.stageLabel, owner: d.ownerDisplayName, lostReason: d.lostReason || undefined, deliveryId } };
  await Lead.updateOne({ _id: lead._id }, { $set: set, $push: { timeline: entry } });
  await audit(null, {
    action: 'lead.hub_status', entityType: 'Lead', entityId: lead._id,
    before: { hubStatus: lead.hub && lead.hub.status }, after: { hubStatus: d.status, event: body.type },
    reason: `Growth Hub webhook ${deliveryId}`,
  });
  return { result: 'processed' };
}

async function receive(req) {
  if (!enabled()) throw ApiError.notFound('Hub webhooks are not enabled', 'HUB_WEBHOOKS_DISABLED');
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const deliveryId = String(req.headers['x-hub-delivery-id'] || '').slice(0, 100);
  if (!verify(raw, req.headers)) {
    await securityEvent(req, 'webhook.rejected', { meta: { provider: 'hub', event: req.headers['x-hub-event'], deliveryId } });
    throw ApiError.unauthenticated('Invalid hub signature or timestamp', 'SIGNATURE_INVALID');
  }
  let body;
  try { body = JSON.parse(raw); } catch { throw ApiError.badRequest('Body is not JSON', 'INVALID_WEBHOOK'); }
  const id = deliveryId || String(body.deliveryId || '').slice(0, 100);
  if (!id) throw ApiError.badRequest('X-Hub-Delivery-Id is required', 'INVALID_WEBHOOK');
  if (await HubWebhook.exists({ deliveryId: id })) return { received: true, duplicate: true };
  const type = body.type || req.headers['x-hub-event'];
  let row;
  try {
    row = await HubWebhook.create({
      deliveryId: id, event: type, platform: body.platform || req.headers['x-hub-platform'],
      externalLeadId: body.data && body.data.externalLeadId ? String(body.data.externalLeadId).slice(0, 64) : undefined,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined, test: Boolean(body.test),
    });
  } catch (err) {
    if (err.code === 11000) return { received: true, duplicate: true }; // a parallel retry won the insert
    throw err;
  }
  try {
    const out = await apply({ ...body, type }, id);
    await HubWebhook.updateOne({ _id: row._id }, { $set: { result: out.result, note: out.note } });
    return { received: true, duplicate: false, result: out.result };
  } catch (err) {
    await HubWebhook.deleteOne({ _id: row._id }).catch(() => {}); // let the hub retry this delivery
    throw err;
  }
}

module.exports = { receive, verify, apply, enabled, HubWebhook };
