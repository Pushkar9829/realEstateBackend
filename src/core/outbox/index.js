// MLM outbox (platform "realestate"): record events in the same transaction as the business change,
// then a recurring task delivers them with an HMAC signature.
//
// Retry semantics (Common Architecture 7.3):
//   2xx -> sent | 400/401/403/422 -> dead (no retry) | 429/5xx/network -> retry
//   backoff 1m, 5m, 15m, 1h, 6h, then every 6h for up to 7 days.
const { v4: uuid } = require('uuid');
const axios = require('axios');
const Outbox = require('./Outbox.model');
const env = require('../../config/env');
const logger = require('../logger');
const { hmacSha256 } = require('../security/crypto');

const BACKOFF_MIN = [1, 5, 15, 60, 360];
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// schemaVersion: '1' marks the hub's canonical v1 envelope (lead events); the
// original MLM events keep the RE-1 shape the hub accepts unchanged.
async function record(type, data, { session, aggregateId, schemaVersion } = {}) {
  const eventId = uuid();
  const payload = { eventId, type, ...(schemaVersion ? { schemaVersion } : {}), occurredAt: new Date().toISOString(), platform: 'realestate', data };
  const [doc] = await Outbox.create([{ eventId, type, aggregateId, payload }], { session });
  return doc;
}

function sign(rawBody) {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'Content-Type': 'application/json',
    'X-Platform-Key': env.MLM_PLATFORM_KEY,
    'X-Timestamp': ts,
    'X-Signature': hmacSha256(env.MLM_PLATFORM_SECRET, `${ts}.${rawBody}`),
  };
}

async function deliver(doc, { enabled, sendUnreferred }) {
  const d = doc.payload.data || {};
  const referred = d.referralCode || (d.buyer && d.buyer.referralCode) || (d.lister && d.lister.referralCode);
  // Lead events go to the central lead desk whether or not the person was referred.
  if (!referred && !sendUnreferred && !String(doc.type).startsWith('lead.')) {
    await Outbox.updateOne({ _id: doc._id }, { status: 'skipped_unreferred' });
    return;
  }
  if (!enabled || !env.MLM_ENGINE_URL) return; // stays pending until the integration is switched on
  const raw = JSON.stringify(doc.payload);
  const attempts = doc.attempts + 1;
  try {
    const res = await axios.post(`${env.MLM_ENGINE_URL.replace(/\/$/, '')}/api/integrations/realestate/events`, raw, {
      headers: sign(raw), timeout: 10000, validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      await Outbox.updateOne({ _id: doc._id }, { status: 'sent', sentAt: new Date(), attempts, responseCode: res.status, lastError: null, $push: { attemptLog: { at: new Date(), responseCode: res.status } } });
      return;
    }
    if ([400, 401, 403, 422].includes(res.status)) {
      await Outbox.updateOne({ _id: doc._id }, { status: 'dead', attempts, responseCode: res.status, lastError: JSON.stringify(res.data).slice(0, 1000), $push: { attemptLog: { at: new Date(), responseCode: res.status, error: 'rejected' } } });
      return;
    }
    throw Object.assign(new Error(`HTTP ${res.status}`), { responseCode: res.status });
  } catch (err) {
    const tooOld = Date.now() - new Date(doc.createdAt).getTime() > MAX_AGE_MS;
    const waitMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
    await Outbox.updateOne({ _id: doc._id }, {
      status: tooOld ? 'dead' : 'pending',
      attempts,
      responseCode: err.responseCode,
      lastError: err.message,
      nextAttemptAt: new Date(Date.now() + waitMin * 60 * 1000),
      $push: { attemptLog: { $each: [{ at: new Date(), responseCode: err.responseCode, error: err.message }], $slice: -20 } },
    });
  }
}

// Called by the job worker on a schedule (see src/jobs.js).
async function dispatchDue(settings) {
  const due = await Outbox.find({ status: 'pending', nextAttemptAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(50);
  for (const doc of due) {
    try { await deliver(doc, settings); } catch (err) { logger.error({ err, eventId: doc.eventId }, 'Outbox delivery error'); }
  }
}

module.exports = { record, dispatchDue, sign, Outbox };
