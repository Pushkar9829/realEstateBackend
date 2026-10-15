// Module O - lister panel: dashboard aggregates and per-listing stats (RE-O-08).
const { asyncHandler, ok } = require('../../../core/http');
const svc = require('../service');

module.exports = {
  listingStats: asyncHandler(async (req, res) => ok(res, await svc.listingStats(req.user, req.params.id, req.query))),
  aggregates: asyncHandler(async (req, res) => ok(res, await svc.listerDashboard(req.user))),
};
