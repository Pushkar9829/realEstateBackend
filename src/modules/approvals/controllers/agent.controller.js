// Module D - agent panel: own site verification visits and their outcome (RE-D-13, Could).
const { asyncHandler, ok } = require('../../../core/http');
const siteVisits = require('../site-visits.service');

module.exports = {
  checklistPhotosResult: asyncHandler(async (req, res) => ok(res, await siteVisits.outcome(req.user, req.params.id, req.body, req))),
  ownVerificationVisits: asyncHandler(async (req, res) => { const { items, meta } = await siteVisits.own(req.user, req.query); ok(res, items, meta); }),
};
