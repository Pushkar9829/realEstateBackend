// Module I - Commission Receivables & Invoicing
module.exports = {
  key: 'receivables',
  letter: 'I',
  name: 'Commission Receivables & Invoicing',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    lister: require('./routes/lister.routes'),
  },
  register() {
    const { daily } = require('../../core/schedule');
    daily('receivables.daily', { hour: 7 }, (now) => require('./service').runDaily(now)); // overdue + reminders (RE-I-06)
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
