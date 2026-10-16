// Module F - lister KYC and no-broker declaration (RE-F-01, 02, 09).
const { asyncHandler, ok } = require('../../../core/http');
const kyc = require('../service');
const brand = require('../brand.service');

module.exports = {
  ownKyc: asyncHandler(async (req, res) => ok(res, await kyc.getOwn(req.user))), // GET /api/lister/kyc
  saveForm: asyncHandler(async (req, res) => ok(res, await kyc.saveForm(req.user, req.body, req))), // PUT /api/lister/kyc
  uploadDocument: asyncHandler(async (req, res) => ok(res, await kyc.addDocument(req.user, req.body, req))), // POST /api/lister/kyc/documents { docType, fileId }
  removeDocument: asyncHandler(async (req, res) => ok(res, await kyc.removeDocument(req.user, req.params.docId))), // DELETE /api/lister/kyc/documents/:docId
  submit: asyncHandler(async (req, res) => ok(res, await kyc.submit(req.user, req.body, req))), // POST /api/lister/kyc/submit
  ownBrand: asyncHandler(async (req, res) => ok(res, await brand.getOwn(req.user))), // GET /api/lister/profile/brand
  requestBrand: asyncHandler(async (req, res) => ok(res, await brand.request(req.user, req.body, req))), // PATCH /api/lister/profile/brand { name, logoFileId }
};
