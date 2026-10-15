// Background work without Redis: module job handlers + recurring tasks run on
// the in-process MongoDB-backed worker (core/jobs).
const jobs = require('./core/jobs');
const outbox = require('./core/outbox');
const settings = require('./core/settings');
const notify = require('./core/notify');
const modules = require('./modules');

let registered = false;

function registerAll() {
  if (registered) return;
  registered = true;

  // Shared job types
  jobs.register('notify.email', (p) => notify.sendEmail(p));
  jobs.register('notify.sms', (p) => notify.sendSms(p));

  // MLM outbox delivery every 30 s (no-op until mlm.enabled and MLM_ENGINE_URL are set)
  jobs.every('mlm.outbox.dispatch', 30 * 1000, async () => {
    const s = await settings.all();
    await outbox.dispatchDue({ enabled: s['mlm.enabled'], sendUnreferred: s['mlm.sendUnreferred'] });
  });

  // Each module registers its own job handlers, schedules and event listeners.
  modules.forEach((m) => m.register && m.register());
}

module.exports = { registerAll, start: jobs.start, stop: jobs.stop };
