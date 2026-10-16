// Module O - Reports, Audit & System Logs
module.exports = {
  key: 'reports',
  letter: 'O',
  name: 'Reports, Audit & System Logs',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    agent: require('./routes/agent.routes'),
    lister: require('./routes/lister.routes'),
    public: require('./routes/public.routes'),
  },
  register() {
    const jobs = require('../../core/jobs');
    const { daily } = require('../../core/schedule');
    const svc = require('./service');
    jobs.register('reports.export', (p) => svc.runExport(p)); // exports over 10,000 rows (RE-O-07)
    jobs.every('reports.exports.expire', 60 * 60 * 1000, () => svc.expireExports());
    daily('reports.snapshot', { hour: 1 }, (now) => svc.snapshot(now));
    // report.sla_warning: reported listings close to the reports.reviewSlaHours SLA (RE-E-13)
    jobs.every('reports.listing_sla_warning', 30 * 60 * 1000, () => require('../search/service').reportSlaWarning());
    // RE-O-09 monthly retention on the 1st at 03:00 IST
    daily('retention.leads', { hour: 3 }, (now) => (new Date(now.getTime() + 330 * 60000).getUTCDate() === 1 ? svc.runRetention({ now }) : null));
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
