// Wall-clock schedules on top of jobs.every(): "daily at 08:00 IST" and
// "weekly on Monday 08:00 IST". A run is recorded in the counters collection
// (key cron:<name>:<date>) so each slot runs once even with several workers
// or restarts.
const jobs = require('./jobs');
const { Counter } = require('./counters');

const IST_OFFSET_MIN = 330;

function istParts(d = new Date()) {
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  return { day: t.toISOString().slice(0, 10), hour: t.getUTCHours(), minute: t.getUTCMinutes(), weekday: t.getUTCDay() };
}

// True once per slot: the first caller after the slot time claims it.
async function claimSlot(name, now = new Date()) {
  const key = `cron:${name}:${istParts(now).day}`;
  const doc = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return doc.seq === 1;
}

function due({ hour, minute = 0, weekday }, now = new Date()) {
  const p = istParts(now);
  if (weekday !== undefined && p.weekday !== weekday) return false;
  return p.hour > hour || (p.hour === hour && p.minute >= minute);
}

function daily(name, at, fn) {
  jobs.every(`daily:${name}`, 5 * 60 * 1000, async () => {
    const now = new Date();
    if (due(at, now) && await claimSlot(name, now)) await fn(now);
  });
}

module.exports = { daily, istParts, due, claimSlot };
