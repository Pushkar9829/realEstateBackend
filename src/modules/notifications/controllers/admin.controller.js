// Module K - notification templates (in-app, email, SMS, WhatsApp) and test sends.
const { z } = require('zod');
const { asyncHandler, ok, ApiError } = require('../../../core/http');
const { NotificationTemplate } = require('../models');
const { DEFAULTS, notifyUser, template } = require('../service');
const { audit } = require('../../../core/audit');

const CHANNELS = ['in_app', 'email', 'sms', 'whatsapp'];
const editSchema = z.object({
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(2000),
  dltTemplateId: z.string().max(40).optional(),
  waTemplateName: z.string().max(80).optional(),
  urgent: z.boolean().optional(),
  active: z.boolean().default(true),
});

function assertKnown(key, channel) {
  if (!DEFAULTS[key]) throw ApiError.notFound('Unknown notification event');
  if (!CHANNELS.includes(channel)) throw ApiError.badRequest('Unknown channel');
  if (!DEFAULTS[key][channel] && channel !== 'whatsapp') throw ApiError.badRequest(`Event has no ${channel} template`);
}

module.exports = {
  list: asyncHandler(async (req, res) => {
    const overrides = await NotificationTemplate.find().lean();
    const rows = [];
    Object.entries(DEFAULTS).forEach(([key, def]) => CHANNELS.forEach((channel) => {
      if (!def[channel]) return;
      const o = overrides.find((x) => x.key === key && x.channel === channel);
      rows.push({ key, channel, category: def.category, overridden: Boolean(o), active: o ? o.active : true, subject: o ? o.subject : def[channel].subject, body: o ? o.body : def[channel].body });
    }));
    ok(res, rows);
  }),

  // PATCH /notification-templates/:key/:channel
  edit: asyncHandler(async (req, res) => {
    const { key, channel } = req.params;
    assertKnown(key, channel);
    const data = editSchema.parse(req.body);
    const before = await NotificationTemplate.findOne({ key, channel }).lean();
    const doc = await NotificationTemplate.findOneAndUpdate({ key, channel }, { $set: { ...data, updatedBy: req.user._id } }, { upsert: true, new: true });
    await audit(req, { action: 'notification.template.update', entityType: 'NotificationTemplate', entityId: doc._id, before, after: data });
    ok(res, doc);
  }),

  // POST /notification-templates/:key/:channel/test - sends to the signed-in admin
  testSend: asyncHandler(async (req, res) => {
    const { key, channel } = req.params;
    assertKnown(key, channel);
    if (!(await template(key, channel))) throw ApiError.badRequest('No template for this channel');
    const out = await notifyUser({ user: req.user, event: key, channels: [channel], vars: { code: '123456', purposeLabel: 'test', expiryMin: 5 } });
    ok(res, { queued: Object.keys(out) });
  }),
};
