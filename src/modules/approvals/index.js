// Module D - Admin Approval & Operations
module.exports = {
  key: 'approvals',
  letter: 'D',
  name: 'Admin Approval & Operations',
  models: fileExists('./models') ? require('./models') : {},
  routes: {
    admin: require('./routes/admin.routes'),
    agent: require('./routes/agent.routes'),
    lister: require('./routes/lister.routes'),
  },
  register() {},
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
