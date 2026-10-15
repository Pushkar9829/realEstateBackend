// Module C - telephony webhook (RE-C-22, Could). Without a configured provider
// the endpoint answers 503 so a misconfigured provider retries later.
const { asyncHandler } = require('../../../core/http');
const env = require('../../../config/env');

module.exports = {
  callStatusInboundCallsCould: asyncHandler(async (req, res) => {
    if (env.TELEPHONY_PROVIDER === 'none') return res.status(503).json({ success: false, error: { code: 'TELEPHONY_DISABLED', message: 'Telephony is not configured' } });
    return res.status(202).json({ success: true, data: { received: true } });
  }),
};
