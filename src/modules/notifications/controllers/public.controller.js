// Module K - notification centre and preferences (any signed-in user).
const { z } = require('zod');
const { asyncHandler, ok, paginate, ApiError } = require('../../../core/http');
const { Notification } = require('../models');
const { User } = require('../../auth/models');

const CATEGORIES = ['account', 'listings', 'leads', 'visits', 'offers', 'deals', 'invoices', 'alerts', 'marketing'];
const prefsSchema = z.record(z.enum(CATEGORIES), z.object({
  email: z.boolean().optional(), sms: z.boolean().optional(), in_app: z.boolean().optional(), whatsapp: z.boolean().optional(),
}).strict());

module.exports = {
  // GET /me/notifications (?unread=true)
  list: asyncHandler(async (req, res) => {
    const filter = { userId: req.user._id };
    if (req.query.unread === 'true') filter.readAt = null;
    const { items, meta } = await paginate(Notification, filter, req.query);
    ok(res, items, meta);
  }),
  badge: asyncHandler(async (req, res) => ok(res, { count: await Notification.countDocuments({ userId: req.user._id, readAt: null }) })),
  markRead: asyncHandler(async (req, res) => {
    const n = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { $set: { readAt: new Date() } }, { new: true });
    if (!n) throw ApiError.notFound('Notification not found');
    ok(res, n);
  }),
  markAllRead: asyncHandler(async (req, res) => {
    const r = await Notification.updateMany({ userId: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
    ok(res, { updated: r.modifiedCount });
  }),
  preferences: asyncHandler(async (req, res) => ok(res, { categories: CATEGORIES, prefs: req.user.notificationPrefs || {} })),
  update: asyncHandler(async (req, res) => {
    const prefs = prefsSchema.parse(req.body);
    const user = await User.findById(req.user._id);
    user.notificationPrefs = { ...(user.notificationPrefs || {}), ...prefs };
    user.markModified('notificationPrefs');
    await user.save();
    ok(res, user.notificationPrefs);
  }),
};
