// Notification templates added in the spec-gap pass (account). Merged in templates.js.
// Overrides of two earlier defaults: their in-app links pointed at /account/security
// and /account/privacy, which are not routes; the account page deep links with ?tab=.
const base = require('./templates');

module.exports = {
  'auth.password_changed': { ...base['auth.password_changed'], in_app: { ...base['auth.password_changed'].in_app, link: '/account?tab=security' } },
  'privacy.export_ready': { ...base['privacy.export_ready'], in_app: { ...base['privacy.export_ready'].in_app, link: '/account?tab=privacy' } },
  // RE-M-06: sign-in from an ip + device pair not seen in the user's login history.
  'auth.new_device_login': {
    category: 'account', transactional: true,
    email: {
      subject: 'New login to your {{siteName}} account',
      body: 'New login on {{device}} at {{time}} from {{ip}}. If this was you, no action is needed. If it was not, change your password and use "Log out everywhere" under Account and security right away.',
    },
  },
};
