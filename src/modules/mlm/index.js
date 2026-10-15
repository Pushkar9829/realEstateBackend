// Module N - MLM Referral Capture & Outbox
module.exports = {
  key: 'mlm',
  letter: 'N',
  name: 'MLM Referral Capture & Outbox',
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
