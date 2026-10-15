// Module K - Notifications: in-app centre (kept 180 days) and editable
// email / SMS / WhatsApp templates.
const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

const notificationSchema = new mongoose.Schema({
  userId: { type: ObjectId, ref: 'User', required: true },
  eventKey: { type: String, required: true },
  category: { type: String, default: 'account' },
  title: String,
  body: String,
  link: String,
  readAt: Date,
  createdAt: { type: Date, default: Date.now },
});
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

const notificationTemplateSchema = new mongoose.Schema({
  key: { type: String, required: true },
  channel: { type: String, enum: ['in_app', 'email', 'sms', 'whatsapp'], required: true },
  subject: String,
  body: { type: String, required: true },
  dltTemplateId: String, // SMS (India DLT)
  waTemplateName: String, // WhatsApp Cloud API approved template
  urgent: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  updatedBy: ObjectId,
}, { timestamps: true });
notificationTemplateSchema.index({ key: 1, channel: 1 }, { unique: true });

module.exports = {
  Notification: mongoose.model('Notification', notificationSchema),
  NotificationTemplate: mongoose.model('NotificationTemplate', notificationTemplateSchema),
};
