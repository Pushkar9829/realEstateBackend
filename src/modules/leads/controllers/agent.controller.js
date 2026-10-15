// Module C - agent panel (agents and managers): Today, leads, board, follow-ups,
// site visits, sales sheet, matches and offers.
const { asyncHandler, ok } = require('../../../core/http');
const a = require('../agent.service');

const run = (fn, status = 200) => asyncHandler(async (req, res) => (status === 201 ? res.status(201).json({ success: true, data: await fn(req) }) : ok(res, await fn(req))));
const page = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req); ok(res, items, meta); });

module.exports = {
  todayData: run((req) => a.dashboard(req.user)),
  assignedLeads: page((req) => a.list(req.user, req.query)),
  boardData: run((req) => a.board(req.user)),
  manualLead: run((req) => a.manualLead(req.user, req.body, req), 201),
  leadDetail: run((req) => a.detail(req.user, req.params.id)),
  whatsappTemplate: run((req) => a.whatsappTemplate(req.user, req.params.id, req.body), 201),
  requirementPriority: run((req) => a.patch(req.user, req.params.id, req.body, req)),
  stageChange: run((req) => a.stage(req.user, req.params.id, req.body)),
  callLog: run((req) => a.callLog(req.user, req.params.id, req.body), 201),
  note: run((req) => a.note(req.user, req.params.id, req.body), 201),
  linkProperty: run((req) => a.linkProperty(req.user, req.params.id, req.body)),
  unlinkProperty: run((req) => a.unlinkProperty(req.user, req.params.id, req.params.propertyId)),
  updateToLister: run((req) => a.shareUpdate(req.user, req.params.id, req.body, req), 201),
  askManagerToReassign: run((req) => a.reassignRequest(req.user, req.params.id, req.body)),
  buckets: run((req) => a.followups(req.user)),
  create: run((req) => a.createFollowup(req.user, req.body), 201),
  createForManyLeads: run((req) => a.bulkFollowups(req.user, req.body), 201),
  edit: run((req) => a.editFollowup(req.user, req.params.id, req.body)),
  completeWithOutcome: run((req) => a.completeFollowup(req.user, req.params.id, req.body)),
  calendarRange: run((req) => a.calendar(req.user, req.query)),
  schedule: run((req) => a.scheduleVisit(req.user, req.body), 201),
  rescheduleEdit: run((req) => a.rescheduleVisit(req.user, req.params.id, req.body, req)),
  confirmForBuyer: run((req) => a.confirmVisit(req.user, req.params.id)),
  cancel: run((req) => a.cancelVisit(req.user, req.params.id, req.body)),
  outcome: run((req) => a.outcome(req.user, req.params.id, req.body, req)),
  lookup: run((req) => a.propertySearch(req.query)),
  salesSheetScoped: run((req) => a.salesSheet(req.user, req.params.id)),
  listerSlotsForARange: run((req) => a.agentSlots(req.user, req.params.id, req.query)),
  suggestedListings: run((req) => a.matches(req.user, req.params.id)),
  sendLinksToBuyer: run((req) => a.shareListings(req.user, req.params.id, req.body)),
  recordBuyerOffer: run((req) => a.recordOffer(req.user, req.params.id, req.body), 201),
  buyerCounterAcceptCounter: run((req) => a.buyerRound(req.user, req.params.id, req.body)),
  markListerResponseRelayed: run((req) => a.relay(req.user, req.params.id)),
  buyerWithdraws: run((req) => a.withdraw(req.user, req.params.id, req.body)),
  startMaskedCallCould: run((req) => a.maskedCall(req.user, 'lead', req.params.id)),
  maskedCallToListerCould: run((req) => a.maskedCall(req.user, 'property', req.params.id)),
};
