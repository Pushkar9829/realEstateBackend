// Module M - Authentication & Account Security
module.exports = {
  key: 'auth',
  letter: 'M',
  name: 'Authentication & Account Security',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    public: require('./routes/public.routes'),
  },
  register() {
    // RE-M-10 "download my data" export, built in the background
    require('../../core/jobs').register('privacy.export', (p) => require('./services/account.service').buildDataExport(p));
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
