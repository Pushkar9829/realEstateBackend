// Module I - admin panel: receivables, invoices, payments, proofs, disputes, write-offs.
const { asyncHandler, ok, created } = require('../../../core/http');
const svc = require('../service');

const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));

module.exports = {
  list: asyncHandler(async (req, res) => { const { items, meta } = await svc.list(req.user, req.query); ok(res, items, meta); }),
  csv: asyncHandler(async (req, res) => svc.exportCsv(req.user, req.query, res)),
  detail: run((req) => svc.detail(req.user, req.params.id)),
  draftInvoice: asyncHandler(async (req, res) => created(res, await svc.draftInvoice(req.user, req.params.id, req.body, req))),
  issueEmail: run((req) => svc.issue(req.user, req.params.id, req.body, req)),
  cancelWithCreditNote: run((req) => svc.cancelInvoice(req.user, req.params.id, req.body, req)),
  pdf: asyncHandler(async (req, res) => svc.pdf(req.params.id, res)),
  bulkReminders: run((req) => svc.bulkRemind(req.user, req.body, req)),
  recordPayment: asyncHandler(async (req, res) => created(res, await svc.recordPayment(req.user, req.params.id, req.body, req))),
  confirmRejectProof: run((req) => svc.decideProof(req.user, req.params.id, req.params.proofId, req.body, req)),
  raiseDispute: run((req) => svc.dispute(req.user, req.params.id, req.body, req)),
  resolve: run((req) => svc.resolve(req.user, req.params.id, req.body, req)),
  writeOff: run((req) => svc.writeOff(req.user, req.params.id, req.body, req)),
};
