// Module G - admin project review.
const { asyncHandler, ok } = require('../../../core/http');
const projects = require('../service');

module.exports = {
  queueList: asyncHandler(async (req, res) => { const { items, meta } = await projects.adminQueue(req.query); ok(res, items, meta); }),
  detail: asyncHandler(async (req, res) => ok(res, await projects.adminDetail(req.params.id))),
  claim: asyncHandler(async (req, res) => ok(res, await projects.claim(req.params.id, req))),
  decide: asyncHandler(async (req, res) => ok(res, await projects.decide(req.params.id, req.body, req))),
  privateFileUrl: asyncHandler(async (req, res) => ok(res, await projects.adminFileUrl(req.params.id, req.params.fileId, req))), // signed link (RE-B-12)
  featureDeactivate: asyncHandler(async (req, res) => ok(res, await projects.adminPatch(req.params.id, req.body, req))),
};
