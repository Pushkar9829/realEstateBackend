// Module N - MLM Referral Capture & Outbox: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/outbox', ...g.can('integrations.manage'), c.listEvents); // admin (integrations.manage): List events
router.get('/outbox/:id', ...g.can('integrations.manage'), c.payloadAndAttempts); // admin (integrations.manage): Payload and attempts
router.post('/outbox/:id/retry', ...g.can('integrations.manage'), c.retryNow); // admin (integrations.manage): Retry now
router.post('/outbox/:id/mark-dead', ...g.can('integrations.manage'), c.stopRetries); // admin (integrations.manage): Stop retries
router.get('/jobs', ...g.can('integrations.manage'), c.jobs); // admin (integrations.manage): Jobs
router.post('/jobs/:id/retry', ...g.can('integrations.manage'), c.retryJob); // admin (integrations.manage): Retry job

router.get('/integrations/status', ...g.can('integrations.manage'), c.integrationsStatus); // admin (integrations.manage): Provider, switch and last success / failure per channel

module.exports = router;
