// Module H - agent panel: own deals, documents, submit / cancel, partner services.
const { asyncHandler, ok, created } = require('../../../core/http');
const svc = require('../service');
const partners = require('../partners.service');

const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));

module.exports = {
  homeLoanReferralCould: asyncHandler(async (req, res) => created(res, await partners.referLoan(req.user, req.params.id, req.body, req))),
  rentalAgreementRequestCould: asyncHandler(async (req, res) => created(res, await partners.requestRentalAgreement(req.user, req.params.id, req.body, req))),
  // Active partners only, without payout terms or the agreement file.
  activePartners: run(async (req) => (await partners.list({ ...req.query, active: 'true' })).map((p) => ({ _id: p._id, name: p.name, type: p.type, cities: p.cities }))),
  ownDeals: asyncHandler(async (req, res) => { const { items, meta } = await svc.listOwn(req.user, req.query); ok(res, items, meta); }),
  createDraft: asyncHandler(async (req, res) => created(res, await svc.create(req.user, req.body, req))),
  previewCommission: run((req) => svc.previewCommission(req.user, req.body)),
  detail: run((req) => svc.agentDetail(req.user, req.params.id)),
  editDraftReturned: run((req) => svc.edit(req.user, req.params.id, req.body, req)),
  uploadDocument: asyncHandler(async (req, res) => created(res, await svc.addDocument(req.user, req.params.id, req.body, req))),
  removeDocument: run((req) => svc.removeDocument(req.user, req.params.id, req.params.docId, req)),
  submit: run((req) => svc.submit(req.user, req.params.id, req)),
  cancel: run((req) => svc.cancel(req.user, req.params.id, req.body, req)),
};
