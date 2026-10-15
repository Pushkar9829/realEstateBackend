// Module M - Authentication & Account Security: public panel handlers.
// Handler names were generated from the spec's API table (see routes file).
const { z } = require('zod');
const { asyncHandler, ok, created } = require('../../../core/http');
const v = require('../validators');
const auth = require('../services/auth.service');
const account = require('../services/account.service');

const handle = (schema, fn, status = 200) => asyncHandler(async (req, res) => {
  const body = schema ? schema.parse(req.body || {}) : req.body;
  const data = await fn(body, req);
  return status === 201 ? created(res, data) : ok(res, data);
});

const PURPOSES = ['sales_contact', 'whatsapp_updates', 'marketing_alerts', 'partner_sharing', 'call_recording', 'analytics'];

module.exports = {
  // RE-M-01 / 02 / 04 / 05 registration, login, tokens, reset
  register: handle(v.register, (b, req) => auth.register(b, req), 201), // POST /api/auth/register
  verifyEmailPhoneOtp: handle(v.verifyContact, (b, req) => auth.verifyContact(b, req)), // POST /api/auth/verify-contact
  step1: handle(v.login, (b, req) => auth.login(b, req)), // POST /api/auth/login
  step2: handle(v.verify2fa, (b, req) => auth.verifyLogin2fa(b, req)), // POST /api/auth/login/verify-2fa
  resendOtp: handle(v.resendOtp, (b) => auth.resendOtp(b)), // POST /api/auth/otp/resend
  rotateTokens: handle(v.refresh, (b, req) => auth.refresh(b, req)), // POST /api/auth/refresh
  logout: handle(null, (b, req) => auth.logout(b, req)), // POST /api/auth/logout
  revokeAll: handle(null, (b, req) => auth.logoutAll(req.user)), // POST /api/auth/logout-all
  sendResetOtp: handle(v.forgot, (b, req) => auth.forgotPassword(b, req)), // POST /api/auth/password/forgot
  reset: handle(v.reset, (b, req) => auth.resetPassword(b, req)), // POST /api/auth/password/reset

  // profile, password, TOTP (RE-M-03), sessions and history (RE-M-06)
  profile: handle(null, (b, req) => account.getMe(req.user)), // GET /api/me
  updateProfile: handle(v.updateMe, (b, req) => account.updateMe(req.user, b)), // PATCH /api/me
  changePassword: handle(v.changePassword, (b, req) => auth.changePassword(req.user, b, req)), // PATCH /api/me/password
  totpSecretQr: handle(null, (b, req) => auth.totpSetup(req.user)), // POST /api/me/totp/setup
  confirmTotp: handle(v.totpEnable, (b, req) => auth.totpEnable(req.user, b, req)), // POST /api/me/totp/enable
  disableTotpOtpRequired: handle(v.totpDisable, (b, req) => auth.totpDisable(req.user, b, req)), // DELETE /api/me/totp
  sessions: handle(null, (b, req) => account.listSessions(req.user, req.auth && req.auth.sid)), // GET /api/me/sessions
  history: handle(null, (b, req) => account.loginHistory(req.user)), // GET /api/me/login-history

  // RE-M-09 become a lister (Could)
  convertToLister: handle(v.becomeLister, (b, req) => auth.becomeLister(req.user, b, req)), // POST /api/me/become-lister

  // RE-M-10 data rights
  requestDeletion: handle(v.deletionRequest, (b, req) => account.requestDeletion(req.user, b, req), 201), // POST /api/me/deletion-request
  consentLedger: handle(null, (b, req) => account.consents(req.user)), // GET /api/me/consents
  withdrawAConsent: handle(null, (b, req) => account.withdrawConsent(req.user, z.enum(PURPOSES).parse(req.params.purpose), req)), // POST /api/me/consents/:purpose/withdraw
  prepareMyDataDownload: handle(null, (b, req) => account.requestDataExport(req.user, req), 201), // POST /api/me/data-export
};
