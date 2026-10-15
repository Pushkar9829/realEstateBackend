// Module A - lister panel: listing wizard, media, commission, lifecycle.
const stubs = require('../../../core/http/stubs');
const { asyncHandler, ok, created } = require('../../../core/http');
const listings = require('../service');

const run = (fn, status = 200) => asyncHandler(async (req, res) => { const d = await fn(req); return status === 201 ? created(res, d) : ok(res, d); });

module.exports = {
  // Photo verification (RE-A-20) is scheduled with the public portal (Phase 3).
  ...stubs('A', ['startSessionGetLink', 'badgeStatusAttempts']),

  createDraft: run((req) => listings.createDraft(req.user, req), 201), // POST /api/lister/properties
  listOwnListings: asyncHandler(async (req, res) => { const { items, meta } = await listings.listOwn(req.user, req.query); ok(res, items, meta); }),
  ownListingFullData: run((req) => listings.getOwn(req.user, req.params.id)),
  saveWizardStep: run((req) => listings.saveStep(req.user, req.params.id, req.params.step, req.body, req)), // PATCH .../steps/:step (1-6)
  uploadMediaItem: run((req) => listings.addMedia(req.user, req.params.id, req.body, req), 201), // { kind, fileId, ... } after /api/uploads
  reorderSetCover: run((req) => listings.orderMedia(req.user, req.params.id, req.body)),
  captionTagLabel: run((req) => listings.editMedia(req.user, req.params.id, req.params.mediaId, req.body)),
  removeMedia: run((req) => listings.removeMedia(req.user, req.params.id, req.params.mediaId)),
  currentTemplateForAPurpose: run((req) => listings.currentTemplate(req.query.purpose || 'sale')), // GET /api/lister/agreement-template?purpose=
  acceptCommissionAgreement: run((req) => listings.acceptCommission(req.user, req.params.id, req.body, req)), // step 7
  submitForApproval: run((req) => listings.submit(req.user, req.params.id, req)),
  withdrawSubmission: run((req) => listings.withdraw(req.user, req.params.id, req)),
  renew: run((req) => listings.renew(req.user, req.params.id, req)),
  takeOffMarket: run((req) => listings.deactivate(req.user, req.params.id, req.body, req)),
  backToReview: run((req) => listings.reactivate(req.user, req.params.id, req)),
  copyToNewDraft: run((req) => listings.duplicate(req.user, req.params.id, req), 201),
  softDeleteDraft: run((req) => listings.softDelete(req.user, req.params.id, req)),
  pauseWithReason: run((req) => listings.pause(req.user, req.params.id, req.body, req)),
  resumePausedListing: run((req) => listings.resume(req.user, req.params.id, req)),
  answerOpenCheckInPanel: run((req) => listings.answerInPanel(req.user, req.params.id, req.body, req)),
};

// ---- Phase 3: photo verification (RE-A-20) ----
const verification = require('../verification.service');

Object.assign(module.exports, {
  startSessionGetLink: asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await verification.start(req.user, req.params.id, req) })),
  badgeStatusAttempts: asyncHandler(async (req, res) => ok(res, await verification.badgeStatus(req.user, req.params.id))),
});
