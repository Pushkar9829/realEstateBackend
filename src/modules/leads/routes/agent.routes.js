// Module C - Integrated Lead Management System: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');

router.get('/dashboard', c.todayData); // agent: Today data
router.get('/leads', c.assignedLeads); // agent: Assigned leads
router.get('/leads/board', c.boardData); // agent: Board data
router.post('/leads', c.manualLead); // agent: Manual lead
router.get('/leads/:id', c.leadDetail); // agent: Lead detail
router.patch('/leads/:id', c.requirementPriority); // agent: Requirement, priority
router.patch('/leads/:id/stage', c.stageChange); // agent: Stage change
router.post('/leads/:id/calls', c.callLog); // agent: Call log
router.post('/leads/:id/notes', c.note); // agent: Note
router.post('/leads/:id/properties', c.linkProperty); // agent: Link property
router.delete('/leads/:id/properties/:propertyId', c.unlinkProperty); // agent: Unlink property
router.post('/leads/:id/share-update', c.updateToLister); // agent: Update to lister
router.post('/leads/:id/reassign-request', c.askManagerToReassign); // agent: Ask manager to reassign
router.post('/leads/:id/whatsapp-template', c.whatsappTemplate); // agent: Send an approved WhatsApp template (RE-K-08)
router.get('/followups', c.buckets); // agent: Buckets
router.post('/followups', c.create); // agent: Create
router.post('/followups/bulk', c.createForManyLeads); // agent: Create for many leads
router.patch('/followups/:id', c.edit); // agent: Edit
router.post('/followups/:id/complete', c.completeWithOutcome); // agent: Complete with outcome
router.get('/site-visits', c.calendarRange); // agent: Calendar range
router.post('/site-visits', c.schedule); // agent: Schedule
router.patch('/site-visits/:id', c.rescheduleEdit); // agent: Reschedule / edit
router.post('/site-visits/:id/confirm', c.confirmForBuyer); // agent: Confirm for buyer
router.post('/site-visits/:id/cancel', c.cancel); // agent: Cancel
router.post('/site-visits/:id/outcome', c.outcome); // agent: Outcome
router.get('/properties/search', c.lookup); // agent: Lookup
router.get('/properties/:id', c.salesSheetScoped); // agent: Sales sheet (scoped)
router.get('/properties/:id/visit-slots', c.listerSlotsForARange); // agent: Lister slots for a range
router.get('/leads/:id/matches', c.suggestedListings); // agent: Suggested listings
router.post('/leads/:id/share-listings', c.sendLinksToBuyer); // agent: Send links to buyer
router.post('/leads/:id/offers', c.recordBuyerOffer); // agent: Record buyer offer
router.post('/offers/:id/rounds', c.buyerCounterAcceptCounter); // agent: Buyer counter / accept counter
router.post('/offers/:id/relay', c.markListerResponseRelayed); // agent: Mark lister response relayed
router.post('/offers/:id/withdraw', c.buyerWithdraws); // agent: Buyer withdraws
router.post('/leads/:id/masked-call', c.startMaskedCallCould); // agent: Start masked call (Could)
router.post('/properties/:id/masked-call', c.maskedCallToListerCould); // agent: Masked call to lister (Could)

module.exports = router;
