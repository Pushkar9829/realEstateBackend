// Module O - agent panel: own KPIs (RE-O-03).
const { asyncHandler, ok } = require('../../../core/http');
const svc = require('../service');

module.exports = {
  ownKpis: asyncHandler(async (req, res) => ok(res, await svc.agentPerformance(req.user, req.query))),
};
