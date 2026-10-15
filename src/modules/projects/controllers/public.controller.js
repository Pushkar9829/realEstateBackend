// Module G - public project pages (masked: no builder contact, no exact unit counts).
const { asyncHandler, ok } = require('../../../core/http');
const projects = require('../service');

module.exports = {
  projectSearch: asyncHandler(async (req, res) => { const { items, meta } = await projects.publicSearch(req.query); ok(res, items, meta); }),
  projectDetailMasked: asyncHandler(async (req, res) => ok(res, await projects.publicDetail(req.params.slug))),
};
