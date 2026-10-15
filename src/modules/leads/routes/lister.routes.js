// Module C - Integrated Lead Management System: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');

router.get('/activity', c.sharedUpdates); // lister: Shared updates
router.get('/leads', c.maskedLeadRows); // lister: Masked lead rows
router.get('/visits', c.visitsOnOwnListings); // lister: Visits on own listings
router.post('/activity/:id/respond', c.respond); // lister: Respond
router.get('/availability', c.slotsAndBlackouts); // lister: Slots and blackouts
router.put('/availability', c.saveWeeklySlots); // lister: Save weekly slots
router.post('/availability/blackouts', c.addBlackout); // lister: Add blackout
router.delete('/availability/blackouts/:blackoutId', c.removeBlackout); // lister: Remove blackout (by _id; a numeric index still works)
router.get('/offers', c.offersInbox); // lister: Offers inbox
router.get('/offers/:id', c.offerWithRounds); // lister: Offer with rounds
router.post('/offers/:id/respond', c.acceptCounterDecline); // lister: Accept / counter / decline

module.exports = router;
