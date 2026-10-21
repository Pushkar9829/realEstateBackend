// Module C - telephony webhook (RE-C-22, Could). Without a configured provider
// the endpoint answers 503 so a misconfigured provider retries later.
//
// Growth Hub lead status webhook: the integrations panel is mounted before the
// JSON parser, so the handler reads the raw body itself (the HMAC covers the exact
// bytes). 404 unless MLM_PLATFORM_SECRET is set (hubWebhook.service.js).
const express = require('express');
const { asyncHandler, ok } = require('../../../core/http');
const env = require('../../../config/env');
const hub = require('../hubWebhook.service');

const raw = express.raw({ type: () => true, limit: '256kb' });
const hubHandler = asyncHandler(async (req, res) => ok(res, await hub.receive(req)));

module.exports = {
  callStatusInboundCallsCould: asyncHandler(async (req, res) => {
    if (env.TELEPHONY_PROVIDER === 'none') return res.status(503).json({ success: false, error: { code: 'TELEPHONY_DISABLED', message: 'Telephony is not configured' } });
    return res.status(202).json({ success: true, data: { received: true } });
  }),
  hubLeadWebhook: (req, res, next) => raw(req, res, (err) => (err ? next(err) : hubHandler(req, res, next))),
};
