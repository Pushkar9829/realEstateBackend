// Module A - admin: sold-elsewhere finance checks (RE-A-19). Photo QA (RE-A-20) is Phase 3.
const stubs = require('../../../core/http/stubs');
const { asyncHandler, ok } = require('../../../core/http');
const listings = require('../service');

module.exports = {
  ...stubs('A', ['qaQueue', 'claim', 'approveReject', 'releaseClaim']),
  checksList: asyncHandler(async (req, res) => { const { items, meta } = await listings.listSoldElsewhere(req.query); ok(res, items, meta); }),
  assignDecide: asyncHandler(async (req, res) => ok(res, await listings.decideSoldElsewhere(req.params.id, req.body, req))),
};

// ---- Phase 3: photo verification QA (RE-S-ADM-31) ----
const verification = require('../verification.service');

Object.assign(module.exports, {
  qaQueue: asyncHandler(async (req, res) => { const { items, meta } = await verification.qaQueue({ ...req.query, userId: req.user._id }); ok(res, items, meta); }),
  qaDetail: asyncHandler(async (req, res) => ok(res, await verification.qaDetail(req.params.id))),
  claim: asyncHandler(async (req, res) => ok(res, await verification.claim(req.params.id, req))),
  approveReject: asyncHandler(async (req, res) => ok(res, await verification.decide(req.params.id, req.body, req))),
  releaseClaim: asyncHandler(async (req, res) => ok(res, await verification.release(req.params.id, req))),
});
