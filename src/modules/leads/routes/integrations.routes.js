// Module C - Integrated Lead Management System: integrations panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/integrations.controller');

router.post('/webhooks/telephony', c.callStatusInboundCallsCould); // provider (signed): Call status, inbound calls (Could)
router.post('/integrations/hub/webhooks', c.hubLeadWebhook); // Growth Hub (signed): lead status back from the central lead desk; 404 without MLM_PLATFORM_SECRET

module.exports = router;
