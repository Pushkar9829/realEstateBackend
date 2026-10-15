// Module C - admin panel (managers scoped to their teams): leads, queue, visits.
const { asyncHandler, ok } = require('../../../core/http');
const ad = require('../admin.service');

const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));
const page = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req); ok(res, items, meta); });

module.exports = {
  allLeads: page((req) => ad.list(req.user, req.query)),
  bulkAssign: run((req) => ad.bulkAssign(req.user, req.body, req)),
  queuePanels: run((req) => ad.queue(req.user)),
  csv: asyncHandler(async (req, res) => ad.exportCsv(req.user, req.query, res)),
  detail: run((req) => ad.detail(req.user, req.params.id)),
  assignReassign: run((req) => ad.assign(req.user, req.params.id, req.body, req)),
  reopenLost: run((req) => ad.reopen(req.user, req.params.id, req.body, req)),
  newLeadFromOldLostLead: run((req) => ad.recycle(req.user, req.params.id, req)),
  addNote: run((req) => ad.addNote(req.user, req.params.id, req.body)),
  mergeDuplicates: run((req) => ad.merge(req.user, req.params.id, req.body, req)),
  decideRequest: run((req) => ad.decideRequest(req.user, req.params.id, req.params.reqId, req.body, req)),
  allVisits: page((req) => ad.visits(req.user, req.query)),
  reassignAgent: run((req) => ad.patchVisit(req.user, req.params.id, req.body, req)),
};
