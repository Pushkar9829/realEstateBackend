// Module K - Notifications
module.exports = {
  key: 'notifications',
  letter: 'K',
  name: 'Notifications',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    public: require('./routes/public.routes'),
  },
  register() {},
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
