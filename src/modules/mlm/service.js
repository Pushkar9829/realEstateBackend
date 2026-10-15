// Module N - outbox monitor (RE-N-09), job monitor and own referral codes (RE-N-08).
// deal.closed / deal.reversed are written only by the deal transactions; there
// is deliberately no API that emits an event by hand.
const crypto = require('crypto');
const { z } = require('zod');
const { Outbox } = require('../../core/outbox');
const { Job } = require('../../core/jobs');
const { User } = require('../auth/models');
const env = require('../../config/env');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const notFound = (what) => ApiError.notFound(`${what} not found`);

function listEvents(query) {
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.type) filter.type = query.type;
  if (query.q) filter.$or = [{ eventId: String(query.q) }, { 'payload.data.dealNo': String(query.q) }];
  return paginate(Outbox, filter, query, { projection: 'eventId type aggregateId status attempts nextAttemptAt responseCode lastError sentAt createdAt payload.data.dealNo' });
}

async function counts() {
  const rows = await Outbox.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

async function event(id) {
  if (!oid.safeParse(String(id)).success) throw notFound('Event');
  const e = await Outbox.findById(id).lean();
  if (!e) throw notFound('Event');
  return e;
}

async function retry(id, req) {
  const e = await Outbox.findById(id);
  if (!e) throw notFound('Event');
  if (e.status === 'sent') throw ApiError.conflict('The event was already delivered', 'ALREADY_SENT');
  const before = e.status;
  e.status = 'pending';
  e.nextAttemptAt = new Date();
  await e.save();
  await audit(req, { action: 'outbox.retry', entityType: 'Outbox', entityId: e._id, before: { status: before } });
  return { status: e.status, nextAttemptAt: e.nextAttemptAt };
}

async function markDead(id, body, req) {
  const e = await Outbox.findById(id);
  if (!e) throw notFound('Event');
  if (e.status === 'sent') throw ApiError.conflict('The event was already delivered', 'ALREADY_SENT');
  const reason = String((body && body.reason) || 'Stopped by admin').slice(0, 300);
  const before = e.status;
  e.status = 'dead';
  e.lastError = reason;
  await e.save();
  await audit(req, { action: 'outbox.mark_dead', entityType: 'Outbox', entityId: e._id, before: { status: before }, reason });
  return { status: e.status };
}

function listJobs(query) {
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.type) filter.type = query.type;
  return paginate(Job, filter, query, { projection: 'type status runAt attempts maxAttempts lastError finishedAt createdAt uniqueKey' });
}

async function retryJob(id, req) {
  const j = await Job.findById(id);
  if (!j) throw notFound('Job');
  if (!['failed', 'dead'].includes(j.status)) throw ApiError.conflict(`A ${j.status} job cannot be retried`, 'JOB_NOT_FAILED');
  j.status = 'queued';
  j.runAt = new Date();
  j.attempts = 0;
  j.lockedUntil = undefined;
  await j.save();
  await audit(req, { action: 'job.retry', entityType: 'Job', entityId: j._id });
  return { status: j.status };
}

const newCode = () => crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(8, '7').slice(0, 8);

// Every user gets a code on first ask; the share link carries ?ref=CODE (RE-N-01).
async function myReferral(user) {
  let u = await User.findById(user._id).select('referralCode referredBy');
  for (let i = 0; !u.referralCode && i < 5; i += 1) {
    try {
      u = await User.findOneAndUpdate({ _id: user._id, referralCode: null }, { $set: { referralCode: newCode() } }, { new: true }) || await User.findById(user._id).select('referralCode referredBy');
    } catch (err) { if (err.code !== 11000) throw err; } // duplicate code: try another
  }
  const link = `${env.CLIENT_URL.replace(/\/$/, '')}/?ref=${u.referralCode}`;
  return { code: u.referralCode, shareLink: link, referredBy: u.referredBy || null };
}

// ---------------------------------------------------------------- integration status cards (RE-S-ADM-30)

// Per channel: the provider in use (from env; never keys or secrets), whether it
// is configured and switched on in settings, and the last success / failure
// seen in the job queue, the outbox, stored files or inbound webhooks.
// `tracked` says which of the two timestamps the platform records at all.
const short = (v) => (v ? String(v).slice(0, 200) : null);
const hostOf = (url) => { try { return new URL(url).host; } catch { return null; } };

async function jobActivity(type) {
  const [done, bad, queued, dead] = await Promise.all([
    Job.findOne({ type, status: 'done' }).sort({ finishedAt: -1 }).select('finishedAt').lean(),
    Job.findOne({ type, lastError: { $nin: [null, ''] } }).sort({ updatedAt: -1 }).select('updatedAt lastError status').lean(),
    Job.countDocuments({ type, status: { $in: ['queued', 'running'] } }),
    Job.countDocuments({ type, status: 'dead' }),
  ]);
  return { lastSuccessAt: done ? done.finishedAt : null, lastFailureAt: bad ? bad.updatedAt : null, lastError: bad ? short(bad.lastError) : null, queued, dead, tracked: { success: true, failure: true } };
}

async function webhookRejected(providers) {
  const { SecurityEvent } = require('../../core/audit');
  const e = await SecurityEvent.findOne({ type: 'webhook.rejected', 'meta.provider': { $in: providers } }).sort({ at: -1 }).select('at').lean();
  return e ? e.at : null;
}

function health(c) {
  if (!c.enabled) return 'off';
  if (!c.configured) return 'warning';
  if (c.lastFailureAt && (!c.lastSuccessAt || new Date(c.lastFailureAt) > new Date(c.lastSuccessAt))) return 'error';
  if (c.dead) return 'warning';
  return 'ok';
}

async function integrationsStatus() {
  const settings = require('../../core/settings');
  const storage = require('../../core/storage');
  const { Lead } = require('../leads/models');
  const s = await settings.all();
  const otp = s['auth.otpChannels'] || [];
  const [email, sms, waLead, waRejected, telRejected, lastFile, outOk, outBad, outCounts] = await Promise.all([
    jobActivity('notify.email'),
    jobActivity('notify.sms'),
    Lead.findOne({ sources: 'whatsapp' }).sort({ createdAt: -1 }).select('createdAt').lean(),
    webhookRejected(['whatsapp']),
    webhookRejected(['telephony', 'exotel']),
    storage.FileModel.findOne({ provider: env.STORAGE_PROVIDER }).sort({ createdAt: -1 }).select('createdAt').lean(),
    Outbox.findOne({ status: 'sent' }).sort({ sentAt: -1 }).select('sentAt').lean(),
    Outbox.findOne({ lastError: { $nin: [null, ''] } }).sort({ updatedAt: -1 }).select('updatedAt lastError').lean(),
    counts(),
  ]);
  const smsKeys = { console: !env.isProd, msg91: Boolean(env.MSG91_AUTH_KEY && env.MSG91_SENDER_ID), twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) };
  const channels = [
    {
      key: 'email', label: 'Email', provider: env.isTest ? 'test' : env.SMTP_HOST ? 'smtp' : 'console',
      detail: env.SMTP_HOST ? `SMTP ${env.SMTP_HOST}:${env.SMTP_PORT}` : 'Printed to the server log',
      configured: Boolean(env.SMTP_HOST) || !env.isProd, enabled: true, settingKey: null, note: otp.includes('email') ? 'Also an OTP channel' : null, ...email,
    },
    {
      key: 'sms', label: 'SMS', provider: env.SMS_PROVIDER,
      detail: { console: 'Printed to the server log', msg91: 'MSG91 with DLT templates', twilio: 'Twilio' }[env.SMS_PROVIDER],
      configured: smsKeys[env.SMS_PROVIDER], enabled: otp.includes('sms') || s['notify.agentSmsOnAssign'] !== false, settingKey: 'auth.otpChannels', ...sms,
    },
    {
      key: 'whatsapp', label: 'WhatsApp Business API', provider: env.WHATSAPP_PROVIDER,
      detail: env.WHATSAPP_PROVIDER === 'meta' ? 'Meta Cloud API' : 'Console adapter (wa.me link only)',
      configured: env.WHATSAPP_PROVIDER === 'console' || Boolean(env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_APP_SECRET),
      enabled: Boolean(s['whatsapp.enabled']), settingKey: 'whatsapp.enabled',
      lastSuccessAt: waLead ? waLead.createdAt : null, lastFailureAt: waRejected, lastError: waRejected ? 'Inbound webhook rejected (bad signature)' : null,
      tracked: { success: true, failure: true }, note: 'Success = the last inbound message that created a lead',
    },
    {
      key: 'telephony', label: 'Telephony (masked calls)', provider: env.TELEPHONY_PROVIDER,
      detail: env.TELEPHONY_PROVIDER === 'exotel' ? 'Exotel' : 'Not configured: tel: links and manual call logs',
      configured: env.TELEPHONY_PROVIDER === 'exotel' && Boolean(env.EXOTEL_SID && env.EXOTEL_API_KEY && env.EXOTEL_API_TOKEN),
      enabled: Boolean(s['telephony.enabled']) && env.TELEPHONY_PROVIDER !== 'none', settingKey: 'telephony.enabled',
      lastSuccessAt: null, lastFailureAt: telRejected, lastError: telRejected ? 'Status webhook rejected' : null, tracked: { success: false, failure: true },
    },
    {
      key: 'storage', label: 'File storage', provider: env.STORAGE_PROVIDER,
      detail: env.STORAGE_PROVIDER === 'cloudinary' ? 'Cloudinary' : 'Local disk (development only)',
      configured: env.STORAGE_PROVIDER === 'local' ? !env.isProd : Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
      enabled: true, settingKey: null,
      lastSuccessAt: lastFile ? lastFile.createdAt : null, lastFailureAt: null, lastError: null, tracked: { success: true, failure: false }, note: 'Success = the last file stored',
    },
    {
      key: 'geocoder', label: 'Maps and geocoder', provider: env.GEOCODER_PROVIDER,
      detail: { google: 'Google Geocoding API', nominatim: 'OpenStreetMap Nominatim with Leaflet + OSM tiles', none: 'Off: manual pin placement only' }[env.GEOCODER_PROVIDER],
      configured: env.GEOCODER_PROVIDER !== 'google' || Boolean(env.GOOGLE_MAPS_SERVER_KEY), enabled: env.GEOCODER_PROVIDER !== 'none', settingKey: null,
      lastSuccessAt: null, lastFailureAt: null, lastError: null, tracked: { success: false, failure: false },
    },
    {
      key: 'mlm', label: 'MLM engine', provider: env.MLM_ENGINE_URL ? 'mlm_engine' : 'none',
      detail: hostOf(env.MLM_ENGINE_URL) || 'No engine URL: events stay pending in the outbox',
      configured: Boolean(env.MLM_ENGINE_URL && env.MLM_PLATFORM_KEY && env.MLM_PLATFORM_SECRET), enabled: Boolean(s['mlm.enabled']), settingKey: 'mlm.enabled',
      lastSuccessAt: outOk ? outOk.sentAt : null, lastFailureAt: outBad ? outBad.updatedAt : null, lastError: outBad ? short(outBad.lastError) : null,
      queued: outCounts.pending || 0, dead: outCounts.dead || 0, tracked: { success: true, failure: true },
    },
  ];
  return { checkedAt: new Date(), channels: channels.map((c) => ({ ...c, status: health(c) })) };
}

module.exports = { listEvents, counts, event, retry, markDead, listJobs, retryJob, myReferral, integrationsStatus };
