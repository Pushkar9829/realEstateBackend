// Module M - Authentication & Account Security (+ Module F KYC embedded on the
// lister account, + RE-M-10 consent ledger).
const mongoose = require('mongoose');
const { STATUS } = require('../../../constants/status');
const { ROLES, LISTER_TYPES } = require('../../../constants/roles');

const { ObjectId } = mongoose.Schema.Types;

// Lister KYC (Module F), embedded: one per lister account.
const kycSchema = new mongoose.Schema({
  status: { type: String, enum: STATUS.listerKyc.values, default: 'not_started', index: true },
  legalName: String,
  dob: Date,
  panEnc: { type: String, select: false }, // AES-GCM
  panLast4: String,
  panHash: { type: String, select: false }, // duplicate / blocklist checks
  autoChecks: [{ _id: false, code: String, severity: { type: String, enum: ['info', 'warning', 'high'] }, detail: String }],
  aadhaarLast4: String, // masked Aadhaar only, never the full number
  address: { line1: String, line2: String, city: String, state: String, pincode: String },
  company: { name: String, type: { type: String }, cin: String, gstin: String, rera: String, logoUrl: String }, // 'type' must be wrapped or mongoose reads the object as a String
  documents: [{
    docType: String, fileId: { type: ObjectId, ref: 'File' }, hash: String,
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' }, comment: String, uploadedAt: { type: Date, default: Date.now },
  }],
  declaration: { statements: [String], typedName: String, acceptedAt: Date, ip: String, userAgent: String },
  resubmissionCount: { type: Number, default: 0 }, // max 3
  submittedAt: Date,
  reviewedBy: { type: ObjectId, ref: 'User' },
  reviewedAt: Date,
  comment: String,
  rejectReason: String,
  claim: { by: { type: ObjectId, ref: 'User' }, until: Date },
}, { _id: false });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true }, // E.164, Indian or international (RE-M-01)
  passwordHash: { type: String, select: false },
  passwordHistory: { type: [String], select: false }, // last N hashes (auth.passwordHistory)
  role: { type: String, enum: Object.values(ROLES), required: true, index: true },
  listerType: { type: String, enum: LISTER_TYPES }, // listers only
  permissions: { type: [String], default: [], select: false }, // effective keys (admin staff, managers, agents with verification.field)
  extraPermissions: { type: [String], default: [] },
  teamId: { type: ObjectId, ref: 'Team' }, // agents and managers
  listingLimit: Number, // admin override of the active listing limit (listers); null = type default
  status: { type: String, enum: [...STATUS.account.values, 'blocked'], default: 'pending_verification', index: true },
  emailVerified: { type: Boolean, default: false },
  phoneVerified: { type: Boolean, default: false },
  twoFactor: {
    method: { type: String, enum: ['email', 'sms', 'totp'], default: 'email' },
    totpSecretEnc: { type: String, select: false },
    pendingTotpEnc: { type: String, select: false },
    recoveryCodeHashes: { type: [String], select: false },
    enabledAt: Date,
    changedAt: Date,
  },
  kyc: kycSchema,
  billing: { name: String, gstin: String, address: String, state: String }, // listers: invoice recipient
  brand: { // builders; RE-B-02: a change waits in `pending` until an admin approves it
    name: String, logoUrl: String, logoFileId: ObjectId, approved: Boolean,
    pending: { name: String, logoUrl: String, logoFileId: ObjectId, requestedAt: Date },
    reviewedBy: ObjectId, reviewedAt: Date, rejectReason: String,
  },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String, immutable: true },
  referralCapturedAt: Date,
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date,
  blockedReason: String,
  lastLoginAt: Date,
  inviteNonce: { type: String, select: false },
  invitedBy: { type: ObjectId, ref: 'User' },
  mustChangePassword: { type: Boolean, default: false }, // staff first login
  availability: { away: Boolean, leaveFrom: Date, leaveTo: Date }, // agents
  notificationPrefs: { type: mongoose.Schema.Types.Mixed, default: {} },
  locale: { type: String, default: 'en' },
  anonymisedAt: Date,
}, { timestamps: true });

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ role: 1, 'kyc.status': 1 });
userSchema.index({ name: 'text', email: 'text', phone: 'text' });
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash; delete ret.passwordHistory; delete ret.inviteNonce; delete ret.__v;
    if (ret.twoFactor) { delete ret.twoFactor.totpSecretEnc; delete ret.twoFactor.pendingTotpEnc; delete ret.twoFactor.recoveryCodeHashes; }
    if (ret.kyc) delete ret.kyc.panEnc;
    return ret;
  },
});

const otpSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User' },
  target: { type: String, required: true },
  channel: { type: String, enum: ['email', 'sms'], required: true },
  purpose: { type: String, enum: ['verify_email', 'verify_phone', 'login', 'reset_password', 'step_up', 'contact_change', 'guest_enquiry'], required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: Date.now },
  consumedAt: Date,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
otpSchema.index({ target: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

const refreshTokenSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  familyId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  replacedBy: String,
  graceUsedAt: { type: Date, default: null }, // the one reuse allowed within the grace window (session.service)
  ip: String,
  ua: String,
  lastUsedAt: Date,
}, { timestamps: true });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const loginHistorySchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true },
  success: Boolean, method: String, ip: String, ua: String, reason: String,
  at: { type: Date, default: Date.now },
});
loginHistorySchema.index({ userId: 1, at: -1 });
loginHistorySchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

// RE-M-10 consent ledger (DPDP Act): one record per consent given or withdrawn.
const consentSchema = new mongoose.Schema({
  subjectType: { type: String, enum: ['user', 'buyer_contact'], required: true },
  subjectId: { type: ObjectId, required: true, index: true },
  purpose: { type: String, enum: ['sales_contact', 'whatsapp_updates', 'marketing_alerts', 'partner_sharing', 'call_recording', 'analytics'], required: true },
  noticeVersion: String,
  source: { type: String, enum: ['enquiry', 'registration', 'whatsapp', 'agent', 'banner'] },
  givenAt: { type: Date, default: Date.now },
  withdrawnAt: Date,
  ip: String,
}, { timestamps: true });
consentSchema.index({ subjectId: 1, purpose: 1, withdrawnAt: 1 });

// RE-M-10 data rights: deletion requests handled by admins (users.manage).
const deletionRequestSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true, index: true },
  reason: String,
  status: { type: String, enum: ['requested', 'in_progress', 'completed', 'rejected'], default: 'requested', index: true },
  note: String,
  processedBy: ObjectId,
  processedAt: Date,
}, { timestamps: true });

module.exports = {
  DeletionRequest: mongoose.model('DeletionRequest', deletionRequestSchema),
  User: mongoose.model('User', userSchema),
  Otp: mongoose.model('Otp', otpSchema),
  RefreshToken: mongoose.model('RefreshToken', refreshTokenSchema),
  LoginHistory: mongoose.model('LoginHistory', loginHistorySchema),
  Consent: mongoose.model('Consent', consentSchema),
};
