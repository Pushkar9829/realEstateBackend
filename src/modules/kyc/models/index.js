// Module F - Lister Verification & No-Broker Enforcement. KYC itself is
// embedded on the user (auth models, `kyc`). This module owns broker flags,
// the identifier blocklist and seeker behaviour flags (RE-F-10).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const brokerFlagSchema = new mongoose.Schema({
  flagNo: { type: String, required: true, unique: true },
  listerId: { type: ObjectId, ref: 'User', required: true, index: true },
  rule: { type: String, required: true }, // R1..R6 or manual
  evidence: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['open', 'under_review', 'resolved'], default: 'open', index: true },
  resolution: { type: String, enum: ['cleared', 'warned', 'suspended', 'banned'] },
  note: String,
  resolvedBy: ObjectId,
  resolvedAt: Date,
}, { timestamps: true });

// Banned identifiers (hashed) checked at registration and enquiry.
const blocklistSchema = new mongoose.Schema({
  type: { type: String, enum: ['phone', 'email', 'pan', 'hash', 'seeker_phone'], required: true },
  valueHash: { type: String, required: true },
  reason: String,
  until: Date,
  addedBy: ObjectId,
}, { timestamps: true });
blocklistSchema.index({ type: 1, valueHash: 1 }, { unique: true });

const seekerFlagSchema = new mongoose.Schema({
  flagNo: { type: String, required: true, unique: true },
  phoneHash: { type: String, required: true, index: true },
  phoneMasked: String,
  rule: String,
  window: { from: Date, to: Date },
  counts: { listers: Number, localities: Number, cities: Number, enquiries: Number },
  leadIds: [ObjectId],
  status: { type: String, enum: ['open', 'cleared', 'actioned'], default: 'open', index: true },
  action: { type: String, enum: ['throttle', 'block', 'none'] },
  until: Date,
  note: String,
  decidedBy: ObjectId,
}, { timestamps: true });

module.exports = {
  BrokerFlag: mongoose.model('BrokerFlag', brokerFlagSchema),
  Blocklist: mongoose.model('Blocklist', blocklistSchema),
  SeekerFlag: mongoose.model('SeekerFlag', seekerFlagSchema),
};
