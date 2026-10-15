// Module E - Search & Discovery: shortlists, saved searches with alerts,
// view counting, reported listings and locality price trends (RE-E-17).
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const shortlistSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true },
  propertyId: { type: ObjectId, ref: 'Property', required: true },
  priceAtSave: Number,
}, { timestamps: true });
shortlistSchema.index({ userId: 1, propertyId: 1 }, { unique: true });

const savedSearchSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, minlength: 2, maxlength: 60 },
  filters: { type: mongoose.Schema.Types.Mixed, required: true }, // same shape as the search query
  frequency: { type: String, enum: ['instant', 'daily', 'weekly', 'off'], default: 'daily' },
  channels: { type: [String], default: ['email', 'in_app'] },
  lastAlertAt: Date,
  alertsToday: { count: Number, day: String }, // instant alerts capped at 5 a day
  matchCountSinceVisit: { type: Number, default: 0 },
}, { timestamps: true });

// One view per session per property per day (TTL 2 days).
const propertyViewSchema = new mongoose.Schema({
  propertyId: { type: ObjectId, required: true },
  sessionHash: { type: String, required: true },
  day: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
propertyViewSchema.index({ propertyId: 1, sessionHash: 1, day: 1 }, { unique: true });
propertyViewSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 86400 });

const listingReportSchema = new mongoose.Schema({
  reportNo: { type: String, required: true, unique: true },
  propertyId: { type: ObjectId, ref: 'Property', required: true, index: true },
  reporter: { userId: ObjectId, phone: String, ipHash: String },
  reason: { type: String, enum: ['wrong_info', 'already_sold', 'fraud', 'broker', 'duplicate', 'other'], required: true },
  details: { type: String, maxlength: 1000 },
  status: { type: String, enum: ['open', 'under_review', 'actioned', 'dismissed'], default: 'open', index: true },
  action: String,
  note: String,
  decidedBy: ObjectId,
  decidedAt: Date,
}, { timestamps: true });

// Monthly price / rent per sq ft per locality; published with >= trends.minDataPoints points.
const localityTrendSchema = new mongoose.Schema({
  localityId: { type: ObjectId, ref: 'Master', required: true },
  cityId: { type: ObjectId, ref: 'Master' },
  month: { type: String, required: true }, // "2026-10"
  purpose: { type: String, enum: ['sale', 'rent'], required: true },
  category: String,
  medianPerSqft: Number,
  avgPerSqft: Number,
  dataPoints: Number,
  sources: { listings: Number, deals: Number },
  published: Boolean,
}, { timestamps: true });
localityTrendSchema.index({ localityId: 1, purpose: 1, category: 1, month: 1 }, { unique: true });

module.exports = {
  Shortlist: mongoose.model('Shortlist', shortlistSchema),
  SavedSearch: mongoose.model('SavedSearch', savedSearchSchema),
  PropertyView: mongoose.model('PropertyView', propertyViewSchema),
  ListingReport: mongoose.model('ListingReport', listingReportSchema),
  LocalityTrend: mongoose.model('LocalityTrend', localityTrendSchema),
};
