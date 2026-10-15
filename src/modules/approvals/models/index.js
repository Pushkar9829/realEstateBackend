// Module D - Admin Approval & Operations: agreement registry (versioned,
// immutable text snapshot) and site verification visits (RE-D-13, Could).
// Listing / project approval state lives on Property and Project.
const mongoose = require('mongoose');
const { STATUS } = require('../../../constants/status');

const { ObjectId } = mongoose.Schema.Types;

const agreementSchema = new mongoose.Schema({
  agreementNo: { type: String, required: true, unique: true },
  propertyId: { type: ObjectId, ref: 'Property', index: true },
  projectId: { type: ObjectId, ref: 'Project', index: true },
  listerId: { type: ObjectId, ref: 'User', required: true, index: true },
  version: { type: Number, required: true }, // 1..n per property / project
  commissionPercent: { type: Number, required: true }, // 2 decimals
  basis: { type: String, enum: ['sale_price', 'annual_rent'], required: true },
  nonCircumventionMonths: Number,
  templateId: { type: ObjectId, ref: 'AgreementTemplate' },
  templateVersion: Number,
  textSnapshot: { type: String, required: true, immutable: true },
  textHash: { type: String, required: true, immutable: true },
  acceptedName: String,
  acceptedAt: Date,
  ip: String,
  userAgent: String,
  status: { type: String, enum: STATUS.agreement.values, default: 'accepted', index: true },
  effectiveFrom: Date,
  supersededAt: Date,
  terminatedReason: String,
  signedDocument: { fileId: ObjectId, uploadedBy: ObjectId, signedDate: Date },
  source: { type: String, enum: ['click_wrap', 'admin_upload'], default: 'click_wrap' },
  totals: { dealsCount: { type: Number, default: 0 }, commissionVerified: { type: Number, default: 0 } },
}, { timestamps: true });
agreementSchema.index({ propertyId: 1, version: -1 });
agreementSchema.index({ projectId: 1, version: -1 });

const verificationVisitSchema = new mongoose.Schema({
  visitNo: { type: String, required: true, unique: true },
  propertyId: { type: ObjectId, ref: 'Property', required: true, index: true },
  listerId: { type: ObjectId, ref: 'User', required: true },
  requestedBy: ObjectId,
  scheduledAt: Date,
  executiveId: { type: ObjectId, ref: 'User', index: true }, // in-house visiting agent
  status: { type: String, enum: STATUS.verificationVisit.values, default: 'requested', index: true },
  arrivalGps: { lat: Number, lng: Number, accuracy: Number, distanceM: Number },
  checklist: mongoose.Schema.Types.Mixed,
  photos: [ObjectId], // private files
  result: String,
  remarks: String,
  notes: String,
  overrideReason: String,
  cancelReason: String,
  absentReschedules: { type: Number, default: 0 },
  decidedAt: Date,
  history: [{ _id: false, from: String, to: String, by: ObjectId, at: { type: Date, default: Date.now }, note: String }],
}, { timestamps: true });

module.exports = {
  Agreement: mongoose.model('Agreement', agreementSchema),
  VerificationVisit: mongoose.model('VerificationVisit', verificationVisitSchema),
};
