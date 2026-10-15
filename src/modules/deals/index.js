// Module H - Deals & Receipt Verification
module.exports = {
  key: 'deals',
  letter: 'H',
  name: 'Deals & Receipt Verification',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    agent: require('./routes/agent.routes'),
  },
  register() {
    const jobs = require('../../core/jobs');
    const svc = require('./service');
    jobs.every('deals.claims', 5 * 60 * 1000, () => svc.expireClaims()); // 30-minute review locks
    jobs.every('deals.sla', 60 * 60 * 1000, () => svc.slaWarnings()); // deal.verify_sla_warning
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
