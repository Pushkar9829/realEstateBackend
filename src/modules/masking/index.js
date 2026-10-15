// Module B - Identity & Contact Masking
module.exports = {
  key: 'masking',
  letter: 'B',
  name: 'Identity & Contact Masking',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    agent: require('./routes/agent.routes'),
    integrations: require('./routes/integrations.routes'),
    public: require('./routes/public.routes'),
  },
  register() {},
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
