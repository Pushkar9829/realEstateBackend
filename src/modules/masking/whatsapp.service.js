// RE-K-08 / RE-B-14 WhatsApp Cloud API inbound webhook. Signed by Meta with
// X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(app secret, raw body).
//  - text message quoting a listing number -> lead (source whatsapp, the sender
//    number is the verified buyer phone, no OTP; consent "initiated on WhatsApp")
//  - quick reply "check:<token>:<answer>" -> "still available?" answer (RE-A-17)
//  - delivery statuses -> counted only
// Message ids are de-duplicated because Meta retries deliveries.
const env = require('../../config/env');
const settings = require('../../core/settings');
const { Counter } = require('../../core/counters');
const { hmacSha256, safeEqual } = require('../../core/security/crypto');
const { securityEvent } = require('../../core/audit');
const logger = require('../../core/logger');

const LISTING_RX = /\b(RE\d{2}-\d{6}|RE-P-\d{3,})\b/i;

function signatureOk(req) {
  if (!env.WHATSAPP_APP_SECRET) return env.WHATSAPP_PROVIDER === 'console'; // dev console provider only
  const header = String(req.get('x-hub-signature-256') || '');
  const expected = `sha256=${hmacSha256(env.WHATSAPP_APP_SECRET, req.body)}`;
  return Boolean(header) && safeEqual(header, expected);
}

async function firstTime(messageId) {
  const doc = await Counter.findOneAndUpdate({ _id: `wa:msg:${messageId}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq === 1;
}

async function optOut(phone, req) {
  const { Consent, User } = require('../auth/models');
  const { Lead, BuyerContact } = require('../leads/models');
  const [user, contact] = await Promise.all([User.findOne({ phone }).select('_id'), BuyerContact.findOne({ phone }).select('_id')]);
  const subjects = [user && user._id, contact && contact._id].filter(Boolean);
  const r = subjects.length ? await Consent.updateMany({ subjectId: { $in: subjects }, purpose: 'whatsapp_updates', withdrawnAt: null }, { $set: { withdrawnAt: new Date() } }) : { modifiedCount: 0 };
  await Lead.updateMany({ 'buyer.phone': phone, whatsappOptIn: true }, { $set: { whatsappOptIn: false } });
  const { audit } = require('../../core/audit');
  await audit(req, { action: 'consent.withdraw', entityType: 'User', entityId: user ? user._id : undefined, after: { purpose: 'whatsapp_updates', via: 'whatsapp_stop', consents: r.modifiedCount } });
  return { kind: 'text', result: 'opted_out' };
}

async function onText(msg, contact, req) {
  const { Property } = require('../listings/models');
  const capture = require('../leads/capture.service');
  const text = (msg.text && msg.text.body) || '';
  // "STOP" / "UNSUBSCRIBE" opts the sender out of WhatsApp updates (RE-K-08, RE-M-10).
  if (/^\s*(stop|unsubscribe|band karo|बंद करो)\s*$/i.test(text)) return optOut(`+${String(msg.from).replace(/\D/g, '')}`, req);
  const m = text.match(LISTING_RX);
  if (!m) return { kind: 'text', result: 'no_listing' }; // answered by the sales team in the WhatsApp inbox
  const p = await Property.findOne({ listingNo: m[1].toUpperCase(), status: 'live', deletedAt: null }).select('_id');
  if (!p) return { kind: 'text', result: 'listing_unavailable' };
  const name = (contact && contact.profile && contact.profile.name) || undefined;
  try {
    const r = await capture.enquiry({ propertyId: String(p._id), name: name && name.length >= 2 ? name.slice(0, 80) : undefined, message: text.slice(0, 1000), consent: true, whatsappOptIn: true },
      req, { trustedPhone: `+${String(msg.from).replace(/\D/g, '')}`, source: 'whatsapp' });
    return { kind: 'text', result: r.merged ? 'merged' : 'lead', leadNo: r.leadNo };
  } catch (err) {
    return { kind: 'text', result: 'rejected', code: err.code || 'ERROR' };
  }
}

async function onQuickReply(payload, req) {
  const [kind, token, answer] = String(payload || '').split(':');
  if (kind !== 'check' || !token) return { kind: 'reply', result: 'ignored' };
  const listings = require('../listings/service');
  try {
    await listings.answerByToken(token, { answer: answer === 'sold' ? 'sold_elsewhere' : answer }, req);
    return { kind: 'reply', result: 'answered' };
  } catch (err) {
    return { kind: 'reply', result: 'rejected', code: err.code || 'ERROR' };
  }
}

async function handle(req) {
  if (!(await settings.get('whatsapp.enabled'))) return { status: 503, body: { success: false, error: { code: 'WHATSAPP_DISABLED', message: 'WhatsApp is not enabled' } } };
  if (!Buffer.isBuffer(req.body) || !signatureOk(req)) {
    await securityEvent(req, 'webhook.rejected', { meta: { provider: 'whatsapp' } });
    return { status: 401, body: { success: false, error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } } };
  }
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return { status: 400, body: { success: false, error: { code: 'BAD_JSON', message: 'Invalid JSON' } } }; }
  const out = { messages: [], statuses: 0 };
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      out.statuses += (v.statuses || []).length;
      for (const msg of v.messages || []) {
        if (!msg.id || !(await firstTime(msg.id))) continue;
        const contact = (v.contacts || []).find((c) => c.wa_id === msg.from);
        try {
          if (msg.type === 'text') out.messages.push(await onText(msg, contact, req));
          else if (msg.type === 'button') out.messages.push(await onQuickReply(msg.button && msg.button.payload, req));
          else if (msg.type === 'interactive') out.messages.push(await onQuickReply(msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.id, req));
        } catch (err) {
          logger.error({ err, id: msg.id }, 'WhatsApp message failed');
        }
      }
    }
  }
  return { status: 200, body: { success: true, data: out } };
}

module.exports = { handle, signatureOk, LISTING_RX };
