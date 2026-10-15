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
  register() {},
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
