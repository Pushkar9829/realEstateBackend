// Shared helpers for the demo seed: fake request objects for service calls,
// staff / lister loaders, time helpers and a step runner that logs and keeps
// going when one record fails (the seed is idempotent, so a rerun converges).
const mongoose = require('mongoose');

const DAY = 86400000;
const HOUR = 3600000;
const now = () => new Date();
const daysAgo = (d) => new Date(Date.now() - d * DAY);
const daysAhead = (d) => new Date(Date.now() + d * DAY);

// A date at IST hh:mm, `dayOffset` days from today (IST).
function istAt(dayOffset, hh, mm = 0) {
  const ist = new Date(Date.now() + 330 * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + dayOffset, hh, mm) - 330 * 60000);
}

const UA = 'Mozilla/5.0 (demo-seed)';
let ipSeq = 10;
// Minimal Express-like request: services read req.ip, req.headers, req.user and sometimes req.get().
function fakeReq(user, { ip, headers = {} } = {}) {
  ipSeq += 1;
  const h = { 'user-agent': UA, ...headers };
  return { ip: ip || `10.20.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`, headers: h, user, get: (k) => h[String(k).toLowerCase()] };
}

const stats = { ok: 0, skipped: 0, failed: 0, errors: [] };

// Run one seeding step; errors are logged and counted, never fatal.
async function step(label, fn) {
  try {
    const r = await fn();
    if (r === 'skip') stats.skipped += 1; else stats.ok += 1;
    return r;
  } catch (err) {
    stats.failed += 1;
    const detail = err && err.details ? ` ${JSON.stringify(err.details).slice(0, 400)}` : (err && err.issues ? ` ${JSON.stringify(err.issues).slice(0, 400)}` : '');
    stats.errors.push(`${label}: ${err && err.message}${detail}`);
    console.log(`  ! ${label}: ${err && err.message}${detail}`);
    return null;
  }
}

const log = (...a) => console.log(...a);

// Native collection access for backdating timestamps (bypasses mongoose timestamps).
const col = (Model) => Model.collection;

async function loadUser(email) {
  const { User } = require('../../src/modules/auth/models');
  return User.findOne({ email }).select('+permissions');
}

const oid = () => new mongoose.Types.ObjectId();

module.exports = { DAY, HOUR, now, daysAgo, daysAhead, istAt, fakeReq, step, stats, log, col, loadUser, oid };
