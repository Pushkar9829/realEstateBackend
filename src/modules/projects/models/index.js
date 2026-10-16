// Module G - Builder Projects: projects with RERA (RE-G-08), unit
// configurations, private unit inventory and CSV bulk unit imports (RE-G-09).
const mongoose = require('mongoose');
const { pointSchema } = require('../../../core/geo');
const { STATUS } = require('../../../constants/status');

const { ObjectId } = mongoose.Schema.Types;

const configurationSchema = new mongoose.Schema({
  name: { type: String, required: true }, // "2 BHK Type A"
  type: String,
  bhk: Number,
  carpetMin: Number,
  carpetMax: Number,
  priceMin: Number, // paise
  priceMax: Number,
  totalUnits: { type: Number, default: 0 },
  availableUnits: { type: Number, default: 0 },
  floorPlanFileId: ObjectId,
}, { _id: true });

const projectSchema = new mongoose.Schema({
  projectNo: { type: String, required: true, unique: true },
  slug: { type: String, unique: true, sparse: true },
  builderId: { type: ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  description: String,
  status: { type: String, enum: STATUS.project.values, default: 'draft', index: true },
  rera: {
    registrations: [{ _id: false, number: String, state: String, phaseLabel: String, url: String, certificateFileId: ObjectId, validTill: Date, checkedBy: ObjectId, checkedAt: Date }],
    exempt: { reason: String, plotAreaSqm: Number, units: Number, docFileId: ObjectId, approvedBy: ObjectId, approvedAt: Date },
  },
  location: {
    cityId: ObjectId, localityId: ObjectId, city: String, locality: String,
    addressLine: String, pincode: String, landmarks: [{ _id: false, type: { type: String }, name: String }],
    geo: pointSchema, publicGeo: pointSchema,
  },
  configurations: [configurationSchema],
  amenities: [String],
  media: { photos: [{ _id: false, fileId: ObjectId, url: String, caption: String }], brochure: { fileId: ObjectId, url: String }, video: { kind: String, url: String } },
  possession: { status: { type: String, enum: ['ready', 'under_construction'] }, date: Date },
  activeAgreementId: { type: ObjectId, ref: 'Agreement' },
  commission: { percent: Number, acceptedAt: Date },
  inventoryLog: [{ _id: false, configId: ObjectId, from: Number, to: Number, by: ObjectId, reason: { type: String, enum: ['manual', 'deal', 'bulk_upload'] }, at: { type: Date, default: Date.now } }],
  review: { claimedBy: ObjectId, claimUntil: Date },
  reviewComments: [{ _id: false, field: String, comment: String, by: ObjectId, at: Date }],
  rejectionReason: String,
  statusHistory: [{ _id: false, from: String, to: String, actor: ObjectId, at: { type: Date, default: Date.now }, note: String }],
  featured: { on: Boolean, until: Date },
  // RE-G-08 step 5: set by the daily RERA job when a registration's validTill is near (30 days) or past.
  reraExpiry: { status: { type: String, enum: ['ok', 'expiring', 'expired'] }, number: String, validTill: Date, flaggedAt: Date },
  liveAt: Date,
}, { timestamps: true });
projectSchema.index({ 'location.publicGeo': '2dsphere' });

// Private unit inventory (unit numbers never public).
const projectUnitSchema = new mongoose.Schema({
  projectId: { type: ObjectId, ref: 'Project', required: true },
  configId: { type: ObjectId, required: true },
  tower: { type: String, default: '' },
  floor: Number,
  unitNo: { type: String, required: true },
  carpetSqft: Number,
  price: Number, // paise
  status: { type: String, enum: ['available', 'blocked', 'booked', 'sold'], default: 'available' },
  dealId: { type: ObjectId, ref: 'Deal' },
}, { timestamps: true });
projectUnitSchema.index({ projectId: 1, tower: 1, unitNo: 1 }, { unique: true });

const unitImportSchema = new mongoose.Schema({
  projectId: { type: ObjectId, ref: 'Project', required: true },
  fileId: ObjectId,
  rows: Number,
  created: Number,
  updated: Number,
  rowErrors: [{ _id: false, line: Number, reason: String }],
  preview: mongoose.Schema.Types.Mixed,
  status: { type: String, enum: ['previewed', 'confirmed', 'discarded'], default: 'previewed' },
  by: ObjectId,
}, { timestamps: true });

module.exports = {
  Project: mongoose.model('Project', projectSchema),
  ProjectUnit: mongoose.model('ProjectUnit', projectUnitSchema),
  UnitImport: mongoose.model('UnitImport', unitImportSchema),
};
