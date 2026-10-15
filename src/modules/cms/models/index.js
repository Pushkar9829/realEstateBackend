// Module L - CMS & Masters: one `masters` collection (cities, localities,
// property types, amenities, landmark types, reasons, document types),
// pages, banners, FAQs, testimonials and versioned agreement templates.
const mongoose = require('mongoose');
const { pointSchema } = require('../../../core/geo');

const { ObjectId } = mongoose.Schema.Types;

const masterSchema = new mongoose.Schema({
  type: { type: String, enum: ['city', 'locality', 'property_type', 'amenity', 'landmark_type', 'reason', 'doc_type'], required: true },
  code: { type: String, required: true, immutable: true },
  name: { type: String, required: true },
  slug: String,
  parentId: { type: ObjectId, ref: 'Master' }, // locality -> city
  meta: {
    state: String, centroid: pointSchema, pincodes: [String], aliases: [String],
    category: String, fieldProfile: mongoose.Schema.Types.Mixed, group: String, icon: String,
    appliesTo: [String], required: Boolean,
  },
  active: { type: Boolean, default: true },
  sort: { type: Number, default: 0 },
  mergedInto: { type: ObjectId, ref: 'Master' },
  // Locality requested by a lister from the listing wizard (inactive until decided).
  request: { by: ObjectId, propertyId: ObjectId, status: { type: String, enum: ['pending', 'approved', 'rejected'] }, decidedBy: ObjectId, decidedAt: Date, reason: String },
}, { timestamps: true });
masterSchema.index({ type: 1, code: 1 }, { unique: true });
masterSchema.index({ type: 1, parentId: 1, sort: 1 });

const pageSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true }, // about, no-broker-policy, terms, privacy, faq, careers
  title: { type: String, required: true },
  content: { type: String, default: '' },
  meta: { title: String, description: String },
  status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  versions: [{ _id: false, version: Number, content: String, savedBy: ObjectId, savedAt: Date }],
  publishedAt: Date,
}, { timestamps: true });

const bannerSchema = new mongoose.Schema({
  title: String,
  imageFileId: ObjectId,
  imageUrl: String,
  link: String,
  cities: [String], // city targeting; empty = all
  startAt: Date,
  endAt: Date,
  active: { type: Boolean, default: true },
  sort: { type: Number, default: 0 },
}, { timestamps: true });

const faqSchema = new mongoose.Schema({
  group: String, question: { type: String, required: true }, answer: { type: String, required: true },
  active: { type: Boolean, default: true }, sort: { type: Number, default: 0 },
}, { timestamps: true });

const testimonialSchema = new mongoose.Schema({
  name: String, city: String, text: { type: String, required: true }, rating: Number,
  active: { type: Boolean, default: true }, sort: Number,
}, { timestamps: true });

// Versioned commission agreement text (RE-L-08). Publishing requires the
// non-circumvention clause; listings keep the version they accepted.
const agreementTemplateSchema = new mongoose.Schema({
  purpose: { type: String, enum: ['sale', 'rent', 'project'], required: true },
  version: { type: Number, required: true },
  body: { type: String, required: true }, // with {{placeholders}}
  status: { type: String, enum: ['draft', 'published', 'retired'], default: 'draft' },
  publishedAt: Date,
  publishedBy: ObjectId,
}, { timestamps: true });
agreementTemplateSchema.index({ purpose: 1, version: 1 }, { unique: true });

module.exports = {
  Master: mongoose.model('Master', masterSchema),
  Page: mongoose.model('Page', pageSchema),
  Banner: mongoose.model('Banner', bannerSchema),
  Faq: mongoose.model('Faq', faqSchema),
  Testimonial: mongoose.model('Testimonial', testimonialSchema),
  AgreementTemplate: mongoose.model('AgreementTemplate', agreementTemplateSchema),
};
