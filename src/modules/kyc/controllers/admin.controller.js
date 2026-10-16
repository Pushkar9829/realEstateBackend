// Module F - Lister Verification (KYC) & No-Broker Enforcement: admin panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('F', [
  'queue', // GET /api/admin/kyc - Queue
  'detail', // GET /api/admin/kyc/:userId - Detail
  'signedFileUrl', // GET /api/admin/kyc/:userId/documents/:docId - Signed file URL
  'claim', // POST /api/admin/kyc/:userId/claim - Claim
  'release', // POST /api/admin/kyc/:userId/release - Release
  'decide', // POST /api/admin/kyc/:userId/decision - Decide
  'list', // GET /api/admin/listers - List
  'detailGet', // GET /api/admin/listers/:id - Detail
  'suspendBanReinstate', // PATCH /api/admin/listers/:id/status - Suspend / ban / reinstate
  'listingLimitOverride', // PATCH /api/admin/listers/:id/limits - Listing limit override
  'flags', // GET /api/admin/broker-flags - Flags
  'flagDetail', // GET /api/admin/broker-flags/:id - Flag detail
  'manualFlag', // POST /api/admin/broker-flags - Manual flag
  'resolve', // PATCH /api/admin/broker-flags/:id - Resolve
  'seekerFlags', // GET /api/admin/seeker-flags - Seeker flags
  'flagWithLeads', // GET /api/admin/seeker-flags/:id - Flag with leads
  'dismissThrottleBlock', // PATCH /api/admin/seeker-flags/:id - Dismiss / throttle / block
]);

// ---- Phase 2: KYC review, lister status, broker flags (seeker flags arrive with leads) ----
const { asyncHandler, ok, created } = require('../../../core/http');
const kyc = require('../service');

const list = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req.query); ok(res, items, meta); });
const run = (fn, status = 200) => asyncHandler(async (req, res) => { const d = await fn(req); return status === 201 ? created(res, d) : ok(res, d); });

Object.assign(module.exports, {
  queue: list(kyc.queue),
  detail: run((req) => kyc.detail(req.params.userId)),
  signedFileUrl: run((req) => kyc.documentUrl(req.params.userId, req.params.docId, req)),
  claim: run((req) => kyc.claim(req.params.userId, req)),
  release: run((req) => kyc.release(req.params.userId, req)),
  decide: run((req) => kyc.decide(req.params.userId, req.body, req)),
  list: list(kyc.listListers),
  detailGet: run((req) => kyc.listerDetail(req.params.id)),
  suspendBanReinstate: run((req) => kyc.setListerStatus(req.params.id, req.body, req)),
  listingLimitOverride: run((req) => kyc.setListingLimit(req.params.id, req.body, req)),
  flags: list(kyc.listFlags),
  flagDetail: run((req) => kyc.flagDetail(req.params.id)),
  manualFlag: run((req) => kyc.manualFlag(req.body, req), 201),
  resolve: run((req) => kyc.resolveFlag(req.params.id, req.body, req)),
  approveBrand: run((req) => require('../brand.service').decide(req.params.id, req.body, req)), // RE-B-02
});


// ---- Phase 4: seeker behaviour flags (RE-F-10) ----
const seeker = require('../seeker.service');
const { asyncHandler: ah2, ok: ok2 } = require('../../../core/http');

Object.assign(module.exports, {
  seekerFlags: ah2(async (req, res) => { const { items, meta } = await seeker.list(req.query); ok2(res, items, meta); }),
  flagWithLeads: ah2(async (req, res) => ok2(res, await seeker.detail(req.params.id))),
  dismissThrottleBlock: ah2(async (req, res) => ok2(res, await seeker.decide(req.params.id, req.body, req))),
});
