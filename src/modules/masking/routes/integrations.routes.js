// Module B - Identity & Contact Masking: integrations panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const express = require('express');
const c = require('../controllers/integrations.controller');

const router = express.Router();

// Raw body: the X-Hub-Signature-256 HMAC is computed over the exact bytes Meta sent.
router.post('/webhooks/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), c.inboundMessagesQuickRepliesDeliveryStatus); // provider (signed): Inbound messages, quick replies, delivery status

module.exports = router;
