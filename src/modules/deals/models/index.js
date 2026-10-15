// Module H - Deals & Receipt Verification (+ Could: partner referrals for
// home loans and rental agreements, RE-H-10..12). Money in paise.
const mongoose = require('mongoose');
const { STATUS } = require('../../../constants/status');

const { ObjectId } = mongoose.Schema.Types;

const dealSchema = new mongoose.Schema({
  dealNo: { type: String, required: true, unique: true },
  leadId: { type: ObjectId, ref: 'Lead', required: true, index: true },
  propertyId: { type: ObjectId, ref: 'Property', index: true },
  projectId: { type: ObjectId, ref: 'Project' },
  unitConfigId: ObjectId,
  unitNo: String,
  agentId: { type: ObjectId, ref: 'User', required: true, index: true },
  teamId: { type: ObjectId, ref: 'Team' },
  listerId: { type: ObjectId, ref: 'User', required: true },
  dealType: { type: String, enum: ['sale', 'rent'], required: true },
  agreedPrice: Number, // sale (paise)
  monthlyRent: Number, // rent (paise)
  bookingAmount: Number,
  bookingDate: Date,
  paymentMode: { type: String, enum: ['bank_transfer', 'cheque', 'upi', 'cash', 'dd', 'other'] },
  paymentReference: String,
  agreementId: { type: ObjectId, ref: 'Agreement' },
  commissionPercent: Number,
  commissionBasis: { type: String, enum: ['sale_price', 'annual_rent'] },
  commissionAmount: Number, // server computed (paise)
  gstAmount: Number,
  gst: { _id: false, interState: Boolean, cgst: Number, sgst: Number, igst: Number, percent: Number },
  documents: [{ kind: { type: String, enum: ['receipt', 'agreement', 'other'] }, label: String, fileId: ObjectId, sha256: String, reference: String, uploadedBy: ObjectId, at: { type: Date, default: Date.now } }],
  siteVisitIds: [ObjectId],
  notes: String,
  justification: String,
  status: { type: String, enum: STATUS.deal.values, default: 'draft', index: true },
  review: { claimedBy: ObjectId, claimUntil: Date, checklist: mongoose.Schema.Types.Mixed, comment: String, rejectReason: String, note: String, verifiedBy: ObjectId, verifiedAt: Date, idempotencyKey: String },
  reversal: { reason: String, by: ObjectId, at: Date, effectiveDate: Date, leadOutcome: String },
  referral: { buyerReferralCode: String, listerReferralCode: String },
  offerId: { type: ObjectId, ref: 'Offer' },
  resubmissionCount: { type: Number, default: 0 },
  submittedAt: Date,
  slaWarnedAt: Date,
  cancelReason: String,
  statusHistory: [{ _id: false, from: String, to: String, actor: ObjectId, at: { type: Date, default: Date.now }, note: String }],
}, { timestamps: true });
dealSchema.index({ 'documents.sha256': 1 });
dealSchema.index({ 'documents.reference': 1 });

const partnerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['bank', 'nbfc', 'rental_agreement', 'other'], required: true },
  cities: [String],
  contact: { name: String, email: String, phone: String },
  payoutTerms: String,
  agreementFileId: ObjectId,
  active: { type: Boolean, default: true },
}, { timestamps: true });

const partnerReferralSchema = new mongoose.Schema({
  refNo: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['loan', 'rental_agreement'], required: true },
  partnerId: { type: ObjectId, ref: 'Partner' },
  leadId: { type: ObjectId, ref: 'Lead' },
  dealId: { type: ObjectId, ref: 'Deal' },
  consentIds: [ObjectId],
  amount: Number,
  sanctionedAmount: Number, // paise, loans only (set by admin)
  disbursedAmount: Number, // paise, loans only
  status: { type: String, enum: ['referred', 'contacted', 'sanctioned', 'disbursed', 'rejected', 'withdrawn', 'requested', 'in_progress', 'completed', 'cancelled'], default: 'referred' },
  partnerName: String,
  city: String,
  agentId: { type: ObjectId, ref: 'User' },
  partnerRef: String,
  fee: Number,
  payer: String,
  payout: { due: Number, received: Number, status: String },
  documents: [ObjectId],
  timeline: [{ _id: false, type: { type: String }, by: ObjectId, at: Date, note: String }],
}, { timestamps: true });

module.exports = {
  Deal: mongoose.model('Deal', dealSchema),
  Partner: mongoose.model('Partner', partnerSchema),
  PartnerReferral: mongoose.model('PartnerReferral', partnerReferralSchema),
};
