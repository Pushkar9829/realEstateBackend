// Module C - Integrated Lead Management System: buyer contacts, leads,
// follow-ups, site visits, lister visit availability (RE-C-19), offers
// (RE-C-20) and masked updates shared with listers.
const mongoose = require('mongoose');
const { STATUS } = require('../../../constants/status');

const { ObjectId } = mongoose.Schema.Types;

// One record per buyer phone; leads reference it (guest buyers have no user account).
const buyerContactSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true }, // E.164
  name: String,
  email: String,
  userId: { type: ObjectId, ref: 'User' },
  referralCode: String,
  firstSeenAt: { type: Date, default: Date.now },
  anonymisedAt: Date,
}, { timestamps: true });

const timelineSchema = new mongoose.Schema({
  type: { type: String, required: true }, // created, merged, assigned, stage, call, note, visit, offer, share, deal ...
  by: ObjectId,
  at: { type: Date, default: Date.now },
  data: mongoose.Schema.Types.Mixed,
}, { _id: true });

const leadSchema = new mongoose.Schema({
  leadNo: { type: String, required: true, unique: true },
  buyer: { contactId: { type: ObjectId, ref: 'BuyerContact' }, userId: { type: ObjectId, ref: 'User' }, name: String, phone: String, email: String },
  propertyId: { type: ObjectId, ref: 'Property', index: true },
  projectId: { type: ObjectId, ref: 'Project' },
  unitConfigId: ObjectId,
  linkedProperties: { type: [ObjectId], validate: (v) => v.length <= 10 },
  sources: [{ type: String, enum: ['enquiry', 'callback', 'site_visit', 'best_price', 'contact_form', 'whatsapp', 'hotline', 'walk_in', 'referral', 'requirement', 'recycled'] }],
  requirement: {
    purpose: String, city: String, category: String, types: [String], budgetMin: Number, budgetMax: Number, localities: [String], bhk: [Number],
    timeline: String, loanNeeded: Boolean, notes: String,
  },
  // Extra details the buyer gave in the enquiry form (RE-S-PUB-06), shown to the agent.
  enquiry: { callbackWindow: { type: String, enum: ['anytime', 'morning', 'afternoon', 'evening'] }, visitors: Number, pickupNeeded: Boolean },
  stage: { type: String, enum: STATUS.leadStage.values, default: 'new', index: true },
  priority: { type: String, enum: ['hot', 'warm', 'cold'], default: 'warm' },
  buyerLabel: String, // "Buyer N" per property, shown to the lister instead of the identity
  previousStage: String, // for reopen within 30 days
  otpUnverified: Boolean, // guest OTP could not be sent (edge case C1)
  callAttempts: { type: Number, default: 0 },
  unansweredStreak: { type: Number, default: 0 },
  reassignRequests: [{ reason: String, by: ObjectId, at: { type: Date, default: Date.now }, status: { type: String, enum: ['open', 'approved', 'rejected'], default: 'open' }, decidedBy: ObjectId, decidedAt: Date, note: String }],
  assignedTo: { type: ObjectId, ref: 'User', index: true },
  teamId: { type: ObjectId, ref: 'Team', index: true },
  assignedAt: Date,
  slaDueAt: Date,
  firstContactAt: Date,
  slaBreachedAt: Date,
  slaBreachCount: { type: Number, default: 0 },
  lostReason: String,
  lostNote: String,
  referralCode: String, // buyer's MLM referrer
  lastActivityAt: { type: Date, default: Date.now, index: true },
  timeline: [timelineSchema],
  mergedInto: { type: ObjectId, ref: 'Lead' },
  recycledFrom: { type: ObjectId, ref: 'Lead' },
  consentAt: Date,
  whatsappOptIn: Boolean,
  throttled: Boolean, // seeker flag throttle
  seekerFlagId: { type: ObjectId, ref: 'SeekerFlag' },
  utm: { source: String, medium: String, campaign: String },
  closedAt: Date,
  anonymisedAt: Date,
}, { timestamps: true });
leadSchema.index({ 'buyer.phone': 1, propertyId: 1, createdAt: -1 }); // 7-day duplicate merge
leadSchema.index({ assignedTo: 1, stage: 1, lastActivityAt: -1 });
leadSchema.index({ stage: 1, slaDueAt: 1 });

const followUpSchema = new mongoose.Schema({
  leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
  agentId: { type: ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['call', 'whatsapp', 'meeting', 'email', 'other'], default: 'call' },
  dueAt: { type: Date, required: true },
  remindAt: Date,
  note: String,
  status: { type: String, enum: ['open', 'done', 'cancelled'], default: 'open' },
  outcome: String,
  doneAt: Date,
}, { timestamps: true });
followUpSchema.index({ agentId: 1, status: 1, dueAt: 1 });

const siteVisitSchema = new mongoose.Schema({
  visitNo: { type: String, required: true, unique: true },
  leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
  propertyId: { type: ObjectId, ref: 'Property', required: true },
  agentId: { type: ObjectId, ref: 'User', index: true },
  scheduledAt: { type: Date, required: true, index: true },
  durationMin: { type: Number, default: 30 },
  meetingPoint: String,
  buyerNote: String, // shown to the buyer in the confirmation, e.g. "carry a photo ID"
  pickup: { needed: Boolean, address: String },
  status: { type: String, enum: STATUS.siteVisit.values, default: 'requested', index: true },
  rescheduleCount: { type: Number, default: 0 },
  history: [{ _id: false, kind: { type: String, default: 'rescheduled' }, from: Date, to: Date, reason: String, by: ObjectId, at: { type: Date, default: Date.now } }],
  outsideListerSlots: Boolean,
  overrideReason: String,
  confirmTokenHash: String,
  confirmedAt: Date,
  cancelReason: String,
  outcome: { result: String, interest: Number, rating: Number, objections: [String], feedback: String, offerAmount: Number, nextStep: String, photos: [ObjectId], recordedAt: Date },
  remindersSent: [String],
  requestedSlot: Date,
  rescheduleRequest: { at: Date, note: String },
  sharedWithLister: Boolean,
  feedback: { // RE-C-21 post-visit buyer feedback
    tokenHash: String, sentAt: Date, interest: { type: Number, min: 1, max: 5 }, likes: [String], dislikes: [String],
    comments: String, secondVisit: Boolean, callBack: Boolean, submittedAt: Date,
  },
}, { timestamps: true });

// RE-C-19 lister visit slots (account-wide, per project or per property).
const visitAvailabilitySchema = new mongoose.Schema({
  listerId: { type: ObjectId, ref: 'User', required: true, index: true },
  scope: { type: String, enum: ['account', 'project', 'property'], default: 'account' },
  scopeId: ObjectId,
  weekly: [{ _id: false, day: { type: Number, min: 0, max: 6 }, start: String, end: String }], // "10:00"-"18:00"
  noticeHours: { type: Number, default: 2 },
  blackouts: [{ from: Date, to: Date, reason: String }], // stable _id per blackout (DELETE .../blackouts/:blackoutId)
  note: String,
}, { timestamps: true });
visitAvailabilitySchema.index({ listerId: 1, scope: 1, scopeId: 1 }, { unique: true });

// RE-C-20 offers inbox: rounds between agent (for the buyer) and lister.
const offerSchema = new mongoose.Schema({
  offerNo: { type: String, required: true, unique: true },
  leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
  propertyId: { type: ObjectId, ref: 'Property' },
  projectId: { type: ObjectId, ref: 'Project' },
  unitConfigId: ObjectId,
  listerId: { type: ObjectId, ref: 'User', required: true, index: true },
  agentId: { type: ObjectId, ref: 'User', required: true },
  buyerLabel: String, // "Buyer 3" - never the identity
  status: { type: String, enum: STATUS.offer.values, default: 'awaiting_lister', index: true },
  validUntil: Date,
  rounds: [{
    _id: false, n: Number, by: { type: String, enum: ['agent', 'lister'] },
    kind: { type: String, enum: ['offer', 'counter', 'accept', 'decline', 'withdraw'] },
    amount: Number, terms: { token: Number, possessionDate: Date, inclusions: String }, note: String,
    at: { type: Date, default: Date.now }, relayedToBuyerAt: Date,
  }],
  dealId: { type: ObjectId, ref: 'Deal' },
}, { timestamps: true });

// Masked updates an agent shares with the lister (visit outcomes, notes).
const listerUpdateSchema = new mongoose.Schema({
  propertyId: { type: ObjectId, ref: 'Property', required: true, index: true },
  leadId: { type: ObjectId, ref: 'Lead' },
  buyerLabel: String,
  text: { type: String, maxlength: 1000 },
  tag: String,
  amount: Number,
  response: String,
  respondedAt: Date,
  by: ObjectId,
}, { timestamps: true });

module.exports = {
  BuyerContact: mongoose.model('BuyerContact', buyerContactSchema),
  Lead: mongoose.model('Lead', leadSchema),
  FollowUp: mongoose.model('FollowUp', followUpSchema),
  SiteVisit: mongoose.model('SiteVisit', siteVisitSchema),
  VisitAvailability: mongoose.model('VisitAvailability', visitAvailabilitySchema),
  Offer: mongoose.model('Offer', offerSchema),
  ListerUpdate: mongoose.model('ListerUpdate', listerUpdateSchema),
};
