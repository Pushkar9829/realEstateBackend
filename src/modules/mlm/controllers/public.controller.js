// Module N - public panel: the signed-in user's own referral code and share link.
const { asyncHandler, ok } = require('../../../core/http');
const svc = require('../service');

module.exports = {
  ownCodeAndShareLink: asyncHandler(async (req, res) => ok(res, await svc.myReferral(req.user))),
};
