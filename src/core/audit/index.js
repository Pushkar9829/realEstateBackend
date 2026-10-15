// Audit trail (who changed what) and security events (logins, lockouts,
// rejected webhooks). Both are append-only and shown in Admin > System logs.
const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorRole: String, // 'system' for jobs
  action: { type: String, required: true }, // e.g. vendor.kyc.approve
  entityType: String,
  entityId: mongoose.Schema.Types.ObjectId,
  before: mongoose.Schema.Types.Mixed, // changed fields only, secrets redacted
  after: mongoose.Schema.Types.Mixed,
  reason: String,
  ip: String,
  ua: String,
  at: { type: Date, default: Date.now },
});
auditSchema.index({ at: -1 });
auditSchema.index({ entityType: 1, entityId: 1, at: -1 });
auditSchema.index({ actorId: 1, at: -1 });
auditSchema.index({ at: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 3600 });

const securityEventSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, required: true }, // login.failed, account.locked, otp.exceeded, webhook.rejected ...
  ip: String,
  ua: String,
  meta: mongoose.Schema.Types.Mixed,
  at: { type: Date, default: Date.now },
});
securityEventSchema.index({ at: -1 });
securityEventSchema.index({ userId: 1, at: -1 });

const AuditLog = mongoose.model('AuditLog', auditSchema);
const SecurityEvent = mongoose.model('SecurityEvent', securityEventSchema);

const REDACT = /pass|secret|token|otp|accountNo|pan/i;
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, REDACT.test(k) ? '[redacted]' : v]));
}

// audit(req, { action, entityType, entityId, before, after, reason }, { session })
async function audit(req, entry, { session } = {}) {
  const doc = {
    actorId: req?.user?._id,
    actorRole: req?.user?.role || 'system',
    ip: req?.ip,
    ua: req?.headers?.['user-agent'],
    ...entry,
    before: redact(entry.before),
    after: redact(entry.after),
  };
  await AuditLog.create([doc], { session });
}

const securityEvent = (req, type, { userId, meta } = {}) =>
  SecurityEvent.create({ userId, type, meta, ip: req?.ip, ua: req?.headers?.['user-agent'] });

module.exports = { audit, securityEvent, AuditLog, SecurityEvent };
