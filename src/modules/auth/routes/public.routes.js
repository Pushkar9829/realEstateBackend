// Module M - Authentication & Account Security: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');
const g = require('../../../core/middleware/guards');

router.post('/auth/register', c.register); // public: Register
router.post('/auth/verify-contact', c.verifyEmailPhoneOtp); // public: Verify email/phone OTP
router.post('/auth/login', c.step1); // public: Step 1
router.post('/auth/login/verify-2fa', c.step2); // public: Step 2
router.post('/auth/otp/resend', c.resendOtp); // public: Resend OTP
router.post('/auth/refresh', c.rotateTokens); // public: Rotate tokens
router.post('/auth/logout', ...g.anyUser, c.logout); // any: Logout
router.post('/auth/logout-all', ...g.anyUser, c.revokeAll); // any: Revoke all
router.post('/auth/password/forgot', c.sendResetOtp); // public: Send reset OTP
router.post('/auth/password/reset', c.reset); // public: Reset
router.get('/me', ...g.anyUser, c.profile); // any: Profile
router.patch('/me', ...g.anyUser, c.updateProfile); // any: Update profile
router.patch('/me/password', ...g.anyUser, c.changePassword); // any: Change password
router.post('/me/totp/setup', ...g.anyUser, c.totpSecretQr); // any: TOTP secret + QR
router.post('/me/totp/enable', ...g.anyUser, c.confirmTotp); // any: Confirm TOTP
router.delete('/me/totp', ...g.anyUser, c.disableTotpOtpRequired); // any: Disable TOTP (OTP required)
router.get('/me/sessions', ...g.anyUser, c.sessions); // any: Sessions
router.get('/me/login-history', ...g.anyUser, c.history); // any: History
router.post('/me/become-lister', ...g.buyer, c.convertToLister); // buyer: Convert to lister
router.post('/me/deletion-request', ...g.buyerOrLister, c.requestDeletion); // buyer, lister: Request deletion
router.get('/me/consents', ...g.anyUser, c.consentLedger); // any logged in: Consent ledger
router.post('/me/consents/:purpose/withdraw', ...g.anyUser, c.withdrawAConsent); // any logged in: Withdraw a consent
router.post('/me/data-export', ...g.anyUser, c.prepareMyDataDownload); // any logged in: Prepare my data download

module.exports = router;
