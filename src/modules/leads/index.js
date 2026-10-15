// Module C - Integrated Lead Management System
module.exports = {
  key: 'leads',
  letter: 'C',
  name: 'Integrated Lead Management System',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    agent: require('./routes/agent.routes'),
    integrations: require('./routes/integrations.routes'),
    lister: require('./routes/lister.routes'),
    public: require('./routes/public.routes'),
  },
  register() { require('./jobs').register(); },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
