// Module C - public panel: guest OTP, enquiries, contact form, buyer tracker,
// visit actions, token links, public visit slots and post-visit feedback.
const { asyncHandler, ok } = require('../../../core/http');
const capture = require('../capture.service');
const buyer = require('../buyer.service');

const run = (fn, status = 200) => asyncHandler(async (req, res) => (status === 201 ? res.status(201).json({ success: true, data: await fn(req) }) : ok(res, await fn(req))));

module.exports = {
  sendGuestOtp: run((req) => capture.sendOtp(req.body, req)),
  verifyOtpOtptoken: run((req) => capture.verifyOtp(req.body)),
  createOrMergeLead: run((req) => capture.enquiry(req.body, req), 201),
  contactFormLead: run((req) => capture.contactForm(req.body, req), 201),
  ownLeads: run((req) => buyer.myEnquiries(req.user)),
  ownLeadDetailSimplified: run((req) => buyer.myEnquiry(req.user, req.params.id)),
  confirmVisit: run((req) => buyer.meConfirm(req.user, req.params.id)),
  askNewSlot: run((req) => buyer.meReschedule(req.user, req.params.id, req.body)),
  cancelVisit: run((req) => buyer.meCancel(req.user, req.params.id, req.body)),
  tokenLinkConfirmChange: run((req) => buyer.tokenRespond(req.params.token, req.query)),
  freeUnavailableSlots: run((req) => buyer.publicSlots(req.params.id, req.query)),
  feedbackFormData: run((req) => buyer.feedbackForm(req.params.token)),
  submitFeedback: run((req) => buyer.submitFeedback(req.params.token, req.body)),
};
