// Module H - admin panel: verification queue (managers see their teams), claim,
// decision, reversal, signed document links and partner management (Could).
const { asyncHandler, ok, created } = require('../../../core/http');
const svc = require('../service');
const partners = require('../partners.service');

const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));
const page = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req); ok(res, items, meta); });

module.exports = {
  partners: run((req) => partners.list(req.query)),
  createPartner: asyncHandler(async (req, res) => created(res, await partners.create(req.body, req))),
  editDeactivate: run((req) => partners.edit(req.params.id, req.body, req)),
  partnerAgreement: run((req) => partners.agreementUrl(req.params.id, req)),
  referralsAndRequests: page((req) => partners.listReferrals(req.query)),
  statusPayout: run((req) => partners.patchReferral(req.params.id, req.body, req)),
  queue: page((req) => svc.queue(req.user, req.query)),
  detail: run((req) => svc.adminDetail(req.user, req.params.id)),
  signedFileUrl: run((req) => svc.documentUrl(req.user, req.params.id, req.params.docId, req)),
  claim: run((req) => svc.claim(req.user, req.params.id, req)),
  release: run((req) => svc.release(req.user, req.params.id, req)),
  verifyReturnReject: run((req) => svc.decide(req.user, req.params.id, req.body, req)),
  reverse: run((req) => svc.reverse(req.user, req.params.id, req.body, req)),
};
