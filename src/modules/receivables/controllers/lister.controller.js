// Module I - lister panel: own invoices, PDF, payment proofs and disputes.
const { asyncHandler, ok, created } = require('../../../core/http');
const svc = require('../service');

module.exports = {
  ownInvoices: asyncHandler(async (req, res) => { const { items, summary } = await svc.listerInvoices(req.user, req.query); ok(res, items, summary); }),
  detail: asyncHandler(async (req, res) => ok(res, await svc.listerInvoiceDetail(req.user, req.params.id))),
  pdf: asyncHandler(async (req, res) => svc.pdf(req.params.id, res, { listerId: req.user._id })),
  uploadProof: asyncHandler(async (req, res) => created(res, await svc.uploadProof(req.user, req.params.id, req.body, req))),
  raiseDispute: asyncHandler(async (req, res) => ok(res, await svc.listerDispute(req.user, req.params.id, req.body, req))),
};
