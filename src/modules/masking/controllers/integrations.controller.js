// Module B - WhatsApp Cloud API webhook (RE-K-08): inbound messages, quick replies, delivery status.
const { asyncHandler } = require('../../../core/http');
const whatsapp = require('../whatsapp.service');

module.exports = {
  inboundMessagesQuickRepliesDeliveryStatus: asyncHandler(async (req, res) => {
    const r = await whatsapp.handle(req);
    res.status(r.status).json(r.body);
  }),
};
