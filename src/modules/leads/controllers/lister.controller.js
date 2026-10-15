// Module C - lister panel: masked leads, visits, shared updates, availability and offers.
const { asyncHandler, ok } = require('../../../core/http');
const l = require('../lister.service');
const slots = require('../slots.service');

const run = (fn, status = 200) => asyncHandler(async (req, res) => (status === 201 ? res.status(201).json({ success: true, data: await fn(req) }) : ok(res, await fn(req))));

module.exports = {
  sharedUpdates: run((req) => l.activity(req.user, req.query)),
  maskedLeadRows: run((req) => l.leads(req.user, req.query)),
  visitsOnOwnListings: run((req) => l.visits(req.user, req.query)),
  respond: run((req) => l.respond(req.user, req.params.id, req.body, req)),
  slotsAndBlackouts: run((req) => slots.getOwn(req.user, req.query)),
  saveWeeklySlots: run((req) => slots.saveWeekly(req.user, req.body, req)),
  addBlackout: run((req) => slots.addBlackout(req.user, req.body, req), 201),
  removeBlackout: run((req) => slots.removeBlackout(req.user, req.params.blackoutId, req.query, req)),
  offersInbox: run((req) => l.offers(req.user, req.query)),
  offerWithRounds: run((req) => l.offer(req.user, req.params.id)),
  acceptCounterDecline: run((req) => l.respondOffer(req.user, req.params.id, req.body)),
};
