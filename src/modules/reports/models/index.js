// Module O - Reports, Audit & System Logs. Audit logs, security events, jobs
// and the outbox live in core/. This module adds staff contact-reveal audit
// (Module B uses it), nightly report snapshots and CSV export jobs.
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const contactRevealSchema = new mongoose.Schema({
  actorId: { type: ObjectId, ref: 'User', required: true, index: true },
  subjectType: { type: String, enum: ['buyer', 'lister'], required: true },
  subjectId: { type: ObjectId, required: true },
  leadId: ObjectId,
  propertyId: ObjectId,
  field: { type: String, enum: ['phone', 'email', 'address'], required: true },
  ip: String,
  userAgent: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

const reportSnapshotSchema = new mongoose.Schema({
  key: { type: String, required: true }, // listings_by_status, lead_funnel, sla, agent_performance, commission, ageing
  day: { type: String, required: true },
  scope: { teamId: ObjectId },
  data: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
reportSnapshotSchema.index({ key: 1, day: 1, 'scope.teamId': 1 }, { unique: true });

const exportJobSchema = new mongoose.Schema({
  requestedBy: { type: ObjectId, ref: 'User', required: true },
  kind: { type: String, required: true }, // leads, properties, agreements, receivables, report:<key>
  filters: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['queued', 'running', 'ready', 'failed', 'expired'], default: 'queued' },
  fileId: ObjectId,
  rows: Number,
  error: String,
  expiresAt: Date, // download link valid 24 h
}, { timestamps: true });

module.exports = {
  ContactReveal: mongoose.model('ContactReveal', contactRevealSchema),
  ReportSnapshot: mongoose.model('ReportSnapshot', reportSnapshotSchema),
  ExportJob: mongoose.model('ExportJob', exportJobSchema),
};
