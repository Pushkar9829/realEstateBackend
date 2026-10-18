// Module C - Integrated Lead Management System: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');
const g = require('../../../core/middleware/guards');

router.post('/leads/otp', c.sendGuestOtp); // public: Send guest OTP
router.post('/leads/otp/verify', c.verifyOtpOtptoken); // public: Verify OTP -> otpToken
router.post('/leads/enquiry', ...g.optional, c.createOrMergeLead); // public, buyer: Create or merge lead
router.post('/contact', c.contactFormLead); // public: Contact form lead
router.get('/properties/:slug/brochure', ...g.optional, c.propertyBrochure); // public, buyer: Brochure (after an enquiry when gated)
router.get('/projects/:slug/brochure', ...g.optional, c.projectBrochure); // public, buyer: Brochure (after an enquiry when gated)
router.get('/me/enquiries', ...g.buyer, c.ownLeads); // buyer: Own leads
router.get('/me/enquiries/:id', ...g.buyer, c.ownLeadDetailSimplified); // buyer: Own lead detail (simplified)
router.post('/me/site-visits/:id/confirm', ...g.buyer, c.confirmVisit); // buyer: Confirm visit
router.post('/me/site-visits/:id/reschedule-request', ...g.buyer, c.askNewSlot); // buyer: Ask new slot
router.post('/me/site-visits/:id/cancel', ...g.buyer, c.cancelVisit); // buyer: Cancel visit
router.get('/site-visits/respond/:token', c.tokenLinkConfirmChange); // public: Token link confirm / change
router.get('/properties/:id/visit-slots', c.freeUnavailableSlots); // public: Free / unavailable slots
router.get('/site-visits/feedback/:token', c.feedbackFormData); // public (token): Feedback form data
router.post('/site-visits/feedback/:token', c.submitFeedback); // public (token): Submit feedback

module.exports = router;
