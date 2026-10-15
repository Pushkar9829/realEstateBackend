const mongoose = require('mongoose');

// Transactional outbox for MLM engine events (Common Architecture section 7).
const outboxSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true }, // UUID, reused on retries
    type: { type: String, required: true }, // user.signup | deal.closed | deal.reversed
    aggregateId: { type: mongoose.Schema.Types.ObjectId, index: true }, // deal or user
    payload: { type: mongoose.Schema.Types.Mixed, required: true }, // { eventId, type, occurredAt, data }
    status: { type: String, enum: ['pending', 'sent', 'skipped_unreferred', 'dead'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastError: String,
    responseCode: Number,
    sentAt: Date,
    attemptLog: [{ _id: false, at: Date, responseCode: Number, error: String }],
  },
  { timestamps: true },
);

outboxSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model('Outbox', outboxSchema);
