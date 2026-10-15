const mongoose = require('mongoose');

// MongoDB-backed job queue (replaces Redis/BullMQ). See core/jobs/runner.js.
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true }, // e.g. notify.email, logistics.book
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['queued', 'running', 'done', 'failed', 'dead'], default: 'queued' },
    runAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lockedUntil: Date,
    lockedBy: String,
    lastError: String,
    uniqueKey: { type: String }, // dedupe: one open job per key
    finishedAt: Date,
  },
  { timestamps: true },
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ uniqueKey: 1 }, { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' }, status: { $in: ['queued', 'running'] } } });
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: 'done' } });

module.exports = mongoose.model('Job', jobSchema);
