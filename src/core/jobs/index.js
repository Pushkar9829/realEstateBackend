// Job queue API + in-process worker (no Redis).
//
//   jobs.register('notify.email', async (payload, job) => { ... })   // at module load
//   await jobs.enqueue('notify.email', { to, template }, { session, delayMs, uniqueKey })
//
// The worker polls every JOBS_POLL_MS, claims one due job at a time with an
// atomic findOneAndUpdate (safe even with several instances), runs the
// handler and retries with exponential backoff. After maxAttempts the job
// becomes `dead` and is shown in Admin > System > Jobs for retry/discard.
// Recurring tasks (unpaid order timeout, tracking poll, payout eligibility)
// are registered with `every()` and run on the same loop.
const os = require('os');
const Job = require('./Job.model');
const logger = require('../logger');
const env = require('../../config/env');

const handlers = new Map();
const schedules = [];
const workerId = `${os.hostname()}:${process.pid}`;
const LOCK_MS = 5 * 60 * 1000;
let timer = null;
let stopping = false;

function register(type, handler) {
  if (handlers.has(type)) throw new Error(`Job handler already registered: ${type}`);
  handlers.set(type, handler);
}

async function enqueue(type, payload = {}, { session, delayMs = 0, uniqueKey, maxAttempts = 5 } = {}) {
  const doc = { type, payload, runAt: new Date(Date.now() + delayMs), maxAttempts, uniqueKey };
  try {
    const [job] = await Job.create([doc], { session });
    return job;
  } catch (err) {
    if (err.code === 11000 && uniqueKey) return null; // an open job with this key already exists
    throw err;
  }
}

// Recurring task: runs `fn` roughly every `everyMs` (checked on each poll tick).
function every(name, everyMs, fn) {
  schedules.push({ name, everyMs, fn, nextAt: Date.now() + everyMs });
}

const backoffMs = (attempt) => Math.min(6 * 3600 * 1000, 30 * 1000 * 2 ** (attempt - 1)); // 30s, 1m, 2m, 4m ... max 6h

async function claimNext() {
  return Job.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', runAt: { $lte: new Date() } },
        { status: 'running', lockedUntil: { $lt: new Date() } }, // crashed worker
      ],
    },
    { $set: { status: 'running', lockedBy: workerId, lockedUntil: new Date(Date.now() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true },
  );
}

async function runJob(job) {
  const handler = handlers.get(job.type);
  try {
    if (!handler) throw new Error(`No handler registered for ${job.type}`);
    await handler(job.payload, job);
    await Job.updateOne({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date(), lastError: null }, $unset: { lockedUntil: 1 } });
  } catch (err) {
    const dead = job.attempts >= job.maxAttempts;
    await Job.updateOne({ _id: job._id }, {
      $set: {
        status: dead ? 'dead' : 'queued',
        runAt: new Date(Date.now() + backoffMs(job.attempts)),
        lastError: String(err && err.message ? err.message : err).slice(0, 2000),
        ...(dead ? { finishedAt: new Date() } : {}),
      },
      $unset: { lockedUntil: 1 },
    });
    logger.warn({ jobId: job._id, type: job.type, attempts: job.attempts, dead, err: err.message }, 'Job failed');
  }
}

async function tick() {
  const now = Date.now();
  for (const s of schedules) {
    if (now >= s.nextAt) {
      s.nextAt = now + s.everyMs;
      Promise.resolve(s.fn()).catch((err) => logger.error({ err, schedule: s.name }, 'Scheduled task failed'));
    }
  }
  // Drain due jobs (bounded per tick so one slow queue cannot starve the loop).
  for (let i = 0; i < 20 && !stopping; i += 1) {
    const job = await claimNext();
    if (!job) break;
    await runJob(job);
  }
}

function start() {
  if (!env.JOBS_ENABLED || timer) return;
  stopping = false;
  const loop = async () => {
    try { await tick(); } catch (err) { logger.error({ err }, 'Job loop error'); }
    if (!stopping) timer = setTimeout(loop, env.JOBS_POLL_MS);
  };
  timer = setTimeout(loop, 1000); // drain anything left from before a restart/sleep
  logger.info({ workerId, handlers: [...handlers.keys()].length, schedules: schedules.length }, 'Job worker started');
}

function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { register, enqueue, every, start, stop, tick, Job };
