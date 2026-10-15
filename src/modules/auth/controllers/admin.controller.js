// Module M - admin views of data rights (users.manage).
const { asyncHandler, ok } = require('../../../core/http');
const account = require('../services/account.service');
const admin = require('../services/admin-users.service');

module.exports = {
  consentsOfAUser: asyncHandler(async (req, res) => ok(res, await account.userConsents(req.params.id))), // GET /api/admin/users/:id/consents
  users: asyncHandler(async (req, res) => { const { items, meta } = await admin.list(req.query); ok(res, items, meta); }),
  user: asyncHandler(async (req, res) => ok(res, await admin.detail(req.params.id))),
  userStatus: asyncHandler(async (req, res) => ok(res, await admin.setStatus(req.params.id, req.body, req))),
  anonymise: asyncHandler(async (req, res) => ok(res, await admin.anonymise(req.params.id, req.body, req))),
  decideDeletion: asyncHandler(async (req, res) => ok(res, await admin.decideDeletion(req.params.id, req.body, req))),
  settings: asyncHandler(async (req, res) => ok(res, await admin.listSettings(req.user))),
  patchSettings: asyncHandler(async (req, res) => ok(res, await admin.patchSettings(req.user, req.body, req))),
  deletionQueue: asyncHandler(async (req, res) => { const { items, meta } = await account.deletionQueue(req.query); ok(res, items, meta); }), // GET /api/admin/deletion-requests
};
