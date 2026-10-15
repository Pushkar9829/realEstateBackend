// Module A - Property Listing & Catalog Management: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');

router.post('/properties', c.createDraft); // lister: Create draft
router.get('/properties', c.listOwnListings); // lister: List own listings
router.get('/properties/:id', c.ownListingFullData); // lister: Own listing full data
router.patch('/properties/:id/steps/:step', c.saveWizardStep); // lister: Save wizard step
router.post('/properties/:id/media', c.uploadMediaItem); // lister: Upload media item
router.patch('/properties/:id/media/order', c.reorderSetCover); // lister: Reorder, set cover
router.patch('/properties/:id/media/:mediaId', c.captionTagLabel); // lister: Caption, tag, label
router.delete('/properties/:id/media/:mediaId', c.removeMedia); // lister: Remove media
router.get('/agreement-template', c.currentTemplateForAPurpose); // lister: Current template for a purpose
router.post('/properties/:id/commission', c.acceptCommissionAgreement); // lister: Accept commission + agreement
router.post('/properties/:id/submit', c.submitForApproval); // lister: Submit for approval
router.post('/properties/:id/withdraw', c.withdrawSubmission); // lister: Withdraw submission
router.post('/properties/:id/renew', c.renew); // lister: Renew
router.post('/properties/:id/deactivate', c.takeOffMarket); // lister: Take off market
router.post('/properties/:id/reactivate', c.backToReview); // lister: Back to review
router.post('/properties/:id/duplicate', c.copyToNewDraft); // lister: Copy to new draft
router.delete('/properties/:id', c.softDeleteDraft); // lister: Soft delete draft
router.post('/properties/:id/pause', c.pauseWithReason); // lister: Pause with reason
router.post('/properties/:id/resume', c.resumePausedListing); // lister: Resume paused listing
router.post('/properties/:id/availability-check', c.answerOpenCheckInPanel); // lister: Answer open check in panel
router.post('/properties/:id/verification/photo-session', c.startSessionGetLink); // lister: Start session, get link
router.get('/properties/:id/verification', c.badgeStatusAttempts); // lister: Badge status, attempts

module.exports = router;
