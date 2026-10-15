// Module E - Search & Discovery
module.exports = {
  key: 'search',
  letter: 'E',
  name: 'Search & Discovery',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    public: require('./routes/public.routes'),
  },
  register() {
    const jobs = require('../../core/jobs');
    const { daily } = require('../../core/schedule');
    const search = require('./service');
    jobs.register('alerts.match', (p) => search.alertInstant(p.propertyId));
    jobs.register('shortlist.unavailable', async (p) => {
      const prop = await require('../listings/models').Property.findById(p.propertyId).lean();
      return prop ? search.notifyShortlisters(prop, 'shortlist.unavailable', { status: p.status }) : 0;
    });
    daily('alerts.daily', { hour: 8 }, () => search.alertDigest('daily'));
    daily('alerts.weekly', { hour: 8, weekday: 1 }, () => search.alertDigest('weekly'));
    daily('trends.compute', { hour: 1, minute: 30 }, (now) => search.computeTrends(now));
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
