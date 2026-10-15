// Module N - admin panel: MLM outbox monitor, background job monitor and the
// integration status cards.
const { asyncHandler, ok } = require('../../../core/http');
const svc = require('../service');

const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));

module.exports = {
  listEvents: asyncHandler(async (req, res) => { const { items, meta } = await svc.listEvents(req.query); ok(res, items, { ...meta, counts: await svc.counts() }); }),
  payloadAndAttempts: run((req) => svc.event(req.params.id)),
  retryNow: run((req) => svc.retry(req.params.id, req)),
  stopRetries: run((req) => svc.markDead(req.params.id, req.body, req)),
  jobs: asyncHandler(async (req, res) => { const { items, meta } = await svc.listJobs(req.query); ok(res, items, meta); }),
  retryJob: run((req) => svc.retryJob(req.params.id, req)),
  integrationsStatus: run(() => svc.integrationsStatus()),
};
