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
  // RE-N-07: optional user.signup outbox event (only when mlm.events lists it).
  register() {
    const events = require('../../core/events');
    events.on(events.EVENTS.USER_REGISTERED, (p) => require('./service').recordSignup(p));
  },
};

function fileExists(rel) {
  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }
}
