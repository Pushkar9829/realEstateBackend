// Module A - Property Listing & Catalog Management
module.exports = {
  key: 'listings',
  letter: 'A',
  name: 'Property Listing & Catalog Management',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    lister: require('./routes/lister.routes'),
    public: require('./routes/public.routes'),
  },
  register() {
    const jobs = require('../../core/jobs');
    const listings = require('./service');
    // Freshness (expiry, "still available?" checks, reminders, auto-pause): idempotent, run hourly.
    jobs.every('listings.freshness', 3600 * 1000, () => listings.runFreshness());
    jobs.every('listings.archive_drafts', 24 * 3600 * 1000, () => listings.archiveStaleDrafts());
    jobs.every('verification.expire', 3600 * 1000, async () => { await require('./verification.service').expireBadges(); await require('../approvals/site-visits.service').expireSiteBadges(); });
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
