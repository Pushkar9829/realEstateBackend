// Module F - agent panel: manual seeker flag from a lead (RE-F-10).
const { asyncHandler, created } = require('../../../core/http');
const seeker = require('../seeker.service');

module.exports = {
  manualFlagWithNote: asyncHandler(async (req, res) => created(res, await seeker.manualFlag(req.user, req.params.id, req.body, req))),
};
