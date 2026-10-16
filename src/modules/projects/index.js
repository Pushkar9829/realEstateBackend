// Module G - Builder Projects
module.exports = {
  key: 'projects',
  letter: 'G',
  name: 'Builder Projects',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    lister: require('./routes/lister.routes'),
    public: require('./routes/public.routes'),
  },
  register() {
    // RE-G-08 step 5 / RE-L-10 step 4: RERA validity reminders, daily 08:00 IST.
    require('../../core/schedule').daily('rera.expiry', { hour: 8 }, (now) => require('./rera-expiry').run(now));
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
