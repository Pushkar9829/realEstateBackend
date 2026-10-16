// Module A - Property Listing & Catalog Management: properties, availability
// checks ("still available?"), sold-elsewhere checks and photo verification.
// Money is stored in integer paise; the API converts to and from rupees.
const mongoose = require('mongoose');
const { pointSchema } = require('../../../core/geo');
const { STATUS } = require('../../../constants/status');

const { ObjectId } = mongoose.Schema.Types;

const photoSchema = new mongoose.Schema({
  fileId: { type: ObjectId, ref: 'File' },
  url: String,
  thumbUrl: String,
  caption: { type: String, maxlength: 100 },
  tag: String, // room tag: living, kitchen, bedroom ...
  hash: String, // perceptual / sha hash for duplicate-photo checks
  isCover: Boolean,
  sort: Number,
  moderation: { status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }, reason: String },
  fromVerification: Boolean, // added from a photo-verification session
}, { _id: true });

const propertySchema = new mongoose.Schema({
  listingNo: { type: String, required: true, unique: true },
  listerId: { type: ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: ObjectId, ref: 'Project' },
  unitConfigId: ObjectId,
  purpose: { type: String, enum: ['sale', 'rent'], required: true },
  category: { type: String, enum: ['residential', 'commercial', 'land'], required: true },
  type: { type: String, required: true }, // master code: apartment, villa, plot, office ...
  title: { type: String, trim: true, maxlength: 120 },
  description: { type: String, maxlength: 5000 },
  slug: { type: String, unique: true, sparse: true },
  location: {
    cityId: { type: ObjectId, ref: 'Master' },
    localityId: { type: ObjectId, ref: 'Master' },
    city: String, locality: String, societyName: String,
    addressLine: String, // private
    unitNo: String, // private
    pincode: String,
    landmarks: [{ _id: false, type: { type: String }, name: String, distanceKm: Number }],
    geo: pointSchema, // exact pin, private
    publicGeo: pointSchema, // approximate (300-500 m offset) or exact per setting
  },
  details: {
    bhk: Number, baths: Number, balconies: Number,
    areas: { carpet: Number, builtUp: Number, superBuiltUp: Number, plot: Number, unit: { type: String, default: 'sqft' } },
    areaSqft: Number, // normalised for search
    floor: Number, totalFloors: Number,
    furnishing: { type: String, enum: ['unfurnished', 'semi', 'full'] },
    facing: String, ageYears: Number,
    possession: { status: { type: String, enum: ['ready', 'under_construction'] }, date: Date },
    parking: { covered: Number, open: Number },
    extra: mongoose.Schema.Types.Mixed, // type-specific fields from the property type field profile
  },
  price: {
    amount: Number, // sale price (paise)
    monthlyRent: Number, // paise
    deposit: Number,
    maintenance: Number,
    negotiable: Boolean,
    allInclusive: Boolean,
    pricePerSqft: Number,
  },
  amenities: [String],
  rera: {
    numbers: [String], state: String, url: String, certificateFileId: ObjectId, inheritedFromProject: Boolean,
    exempt: { reason: String, docFileId: ObjectId, approvedBy: ObjectId, approvedAt: Date },
  },
  media: {
    photos: [photoSchema],
    video: { kind: { type: String, enum: ['upload', 'youtube'] }, url: String, fileId: ObjectId },
    floorPlans: [{ _id: false, fileId: ObjectId, url: String, label: String }],
    brochure: { fileId: ObjectId, url: String },
    ownershipProofs: [{ _id: false, fileId: ObjectId, docType: String }], // private
  },
  activeAgreementId: { type: ObjectId, ref: 'Agreement' },
  commission: { percent: Number, acceptedAt: Date, acceptedIp: String, acceptedName: String },
  wizard: { stepsDone: [Number], completeness: Number },
  status: { type: String, enum: STATUS.listing.values, default: 'draft', index: true },
  pause: { reason: { type: String, enum: ['lister', 'no_reply', 'admin_review'] }, note: String, pausedAt: Date, by: ObjectId, resumeOn: Date },
  suspendedFromStatus: String, // restored on reinstatement
  inactiveReason: { type: String, enum: ['sold_outside', 'rented_outside', 'no_longer_available', 'agreement_terminated', 'other'] },
  soldOutsideDate: Date,
  availability: { lastCheckAt: Date, lastConfirmedAt: Date, openCheckId: ObjectId },
  verification: {
    photo: { status: { type: String, enum: ['none', 'pending', 'verified', 'rejected', 'expired'], default: 'none' }, sessionId: ObjectId, verifiedAt: Date, expiresAt: Date },
    site: { status: { type: String, enum: ['none', 'scheduled', 'verified', 'not_verified', 'expired'], default: 'none' }, visitId: ObjectId, verifiedAt: Date, expiresAt: Date },
  },
  statusHistory: [{ _id: false, from: String, to: String, actor: ObjectId, at: { type: Date, default: Date.now }, note: String }],
  reviewComments: [{ _id: false, field: String, comment: String, by: ObjectId, at: Date }],
  review: { claimedBy: ObjectId, claimUntil: Date, checklist: mongoose.Schema.Types.Mixed, proofOwnerName: String, reviewedBy: ObjectId, reviewedAt: Date },
  rejectionReason: String,
  pendingRevision: { changes: mongoose.Schema.Types.Mixed, submittedAt: Date, agreementId: ObjectId }, // A2 revision of a live listing
  warnings: [String], // auto-check codes
  featured: { on: Boolean, until: Date },
  stats: { views: { type: Number, default: 0 }, shortlists: { type: Number, default: 0 }, enquiries: { type: Number, default: 0 }, visits: { type: Number, default: 0 }, whatsappClicks: { type: Number, default: 0 }, offers: { type: Number, default: 0 } },
  submittedAt: Date,
  liveAt: Date,
  expiresAt: { type: Date, index: true },
  resubmissionCount: { type: Number, default: 0 },
  revisionNo: { type: Number, default: 0 },
  deletedAt: Date,
}, { timestamps: true });

// Workflow A4 step 4: status changes (from any module) are noticed here and the
// agents on the listing's open leads are told after the save (lead-agents.service).
propertySchema.post('init', function rememberStatus() { this.$locals.loadedStatus = this.status; });
propertySchema.pre('save', function recordStatusChange() {
  const was = this.$locals.loadedStatus;
  if (!this.isNew && was && was !== this.status) (this.$locals.statusChanges = this.$locals.statusChanges || []).push({ from: was, to: this.status });
  this.$locals.loadedStatus = this.status;
});
propertySchema.post('save', async function notifyLeadAgents(doc) { await require('../lead-agents.service').flush(doc); });

propertySchema.index({ 'location.geo': '2dsphere' });
propertySchema.index({ 'location.publicGeo': '2dsphere' });
propertySchema.index({ status: 1, purpose: 1, 'location.cityId': 1, 'location.localityId': 1, 'price.amount': 1 });
propertySchema.index({ status: 1, purpose: 1, 'location.cityId': 1, 'price.monthlyRent': 1 });
propertySchema.index({ status: 1, 'verification.photo.status': 1 });
propertySchema.index({ title: 'text', description: 'text', 'location.locality': 'text', 'location.societyName': 'text' });

// "Still available?" checks (RE-A-17): day 30, 7 days and 1 day before expiry.
const listingCheckSchema = new mongoose.Schema({
  propertyId: { type: ObjectId, ref: 'Property', required: true, index: true },
  listerId: { type: ObjectId, ref: 'User', required: true },
  trigger: { type: String, enum: ['day30', 'expiry7', 'expiry1'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  sentAt: Date,
  channels: [String],
  dueBy: { type: Date, index: true },
  reminderSentAt: Date,
  answer: { type: String, enum: ['available', 'sold_elsewhere', 'pause', 'none'], default: 'none' },
  answeredAt: Date,
  answeredVia: { type: String, enum: ['sms', 'email', 'panel', 'whatsapp'] },
  saleDate: Date,
  price: Number,
  outcome: String,
}, { timestamps: true });

// Sold / rented outside the platform (RE-A-19): finance follow-up with non-circumvention matches.
const soldElsewhereCheckSchema = new mongoose.Schema({
  checkNo: { type: String, required: true, unique: true },
  propertyId: { type: ObjectId, ref: 'Property', required: true },
  listerId: { type: ObjectId, ref: 'User', required: true },
  source: { type: String, enum: ['check', 'deactivation', 'admin'], required: true },
  saleDate: Date,
  price: Number,
  matches: { leads: [ObjectId], visits: [ObjectId], offers: [ObjectId] },
  priority: { type: Boolean, default: false }, // a platform buyer inside the non-circumvention window
  status: { type: String, enum: ['open', 'no_claim', 'claim_raised', 'closed'], default: 'open', index: true },
  claimAmount: Number,
  note: String,
  assignee: { type: ObjectId, ref: 'User' },
  decidedBy: { type: ObjectId, ref: 'User' },
  decidedAt: Date,
}, { timestamps: true });

// Photo verification (RE-A-20): live photos taken at the pin, then QA review.
const verificationSessionSchema = new mongoose.Schema({
  sessionNo: { type: String, required: true, unique: true },
  propertyId: { type: ObjectId, ref: 'Property', required: true, index: true },
  type: { type: String, enum: ['photo'], default: 'photo' },
  tokenHash: { type: String, required: true, unique: true },
  createdBy: { type: ObjectId, ref: 'User' },
  expiresAt: { type: Date, required: true },
  gps: { lat: Number, lng: Number, accuracy: Number, distanceM: Number },
  photos: [{ _id: false, fileId: ObjectId, capturedAt: Date, lat: Number, lng: Number }],
  addToGallery: Boolean,
  status: { type: String, enum: ['open', 'pending_review', 'approved', 'rejected', 'expired'], default: 'open', index: true },
  review: { claimedBy: ObjectId, claimUntil: Date, decision: String, reason: String, comment: String, at: Date },
}, { timestamps: true });

module.exports = {
  Property: mongoose.model('Property', propertySchema),
  ListingCheck: mongoose.model('ListingCheck', listingCheckSchema),
  SoldElsewhereCheck: mongoose.model('SoldElsewhereCheck', soldElsewhereCheckSchema),
  VerificationSession: mongoose.model('VerificationSession', verificationSessionSchema),
};
