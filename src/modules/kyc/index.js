// Module F - Lister Verification (KYC) & No-Broker Enforcement
module.exports = {
  key: 'kyc',
  letter: 'F',
  name: 'Lister Verification (KYC) & No-Broker Enforcement',
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
