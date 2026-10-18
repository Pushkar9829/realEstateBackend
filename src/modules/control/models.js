// Control Center adapter collections (own collections only; no change to existing models).
//   ccstates  single document: maintenance mode, kill switches, rotated CC key
//   ccnonces  used request nonces (10 min TTL, replay protection)
//   ccjtis    used SSO assertion ids (10 min TTL, single use)
//   cclinks   Control Center subject -> linked platform staff account (cc:<sub>)
const mongoose = require('mongoose');

const CcState = mongoose.models.CcState || mongoose.model('CcState', new mongoose.Schema({
  _id: { type: String, default: 'state' },
  maintenance: { on: { type: Boolean, default: false }, message: String, since: Date, by: String },
  flags: { type: mongoose.Schema.Types.Mixed, default: {} }, // key -> { paused, reason, since, by }
  key: { keyId: String, secretEnc: String, previousKeyId: String, previousSecretEnc: String, previousUntil: Date, rotatedAt: Date },
}, { timestamps: true, minimize: false, collection: 'ccstates' }));

const nonceSchema = new mongoose.Schema({ _id: String, at: { type: Date, default: Date.now } }, { collection: 'ccnonces', versionKey: false });
nonceSchema.index({ at: 1 }, { expireAfterSeconds: 600 });
const CcNonce = mongoose.models.CcNonce || mongoose.model('CcNonce', nonceSchema);

const jtiSchema = new mongoose.Schema({ _id: String, sub: String, at: { type: Date, default: Date.now } }, { collection: 'ccjtis', versionKey: false });
jtiSchema.index({ at: 1 }, { expireAfterSeconds: 600 });
const CcJti = mongoose.models.CcJti || mongoose.model('CcJti', jtiSchema);

const CcLink = mongoose.models.CcLink || mongoose.model('CcLink', new mongoose.Schema({
  sub: { type: String, required: true, unique: true }, // Control Center user id
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  email: String, // Control Center email (for display only)
  name: String,
  role: String, // last granted platform role
  lastSsoAt: Date,
}, { timestamps: true, collection: 'cclinks' }));

module.exports = { CcState, CcNonce, CcJti, CcLink };
