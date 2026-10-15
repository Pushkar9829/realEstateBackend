// Module K - notification service used by every module.
//
//   notify({ userId, event, vars, channels, to })   in-app now; email/SMS queued as jobs
//   sendNow({ channel, to, event, vars })           immediate send (OTPs), returns the channel used
//
// Templates: admin override (NotificationTemplate) > default (templates.js).
// Non-urgent SMS falling in quiet hours (notifications.smsQuietHours) are
// delayed until the window ends.
const { Notification, NotificationTemplate } = require('./models');
const DEFAULTS = require('./templates');
const jobs = require('../../core/jobs');
const notify = require('../../core/notify');
const settings = require('../../core/settings');

const render = (text, vars) => String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : ''));

async function template(event, channel) {
  const override = await NotificationTemplate.findOne({ key: event, channel, active: true }).lean();
  const def = DEFAULTS[event] && DEFAULTS[event][channel];
  if (!override && !def) return null;
  return {
    subject: override ? override.subject : def.subject,
    body: override ? override.body : def.body,
    title: def && def.title,
    link: def && def.link,
    urgent: override ? override.urgent : Boolean(def && def.urgent),
    dltTemplateId: override && override.dltTemplateId,
  };
}

async function baseVars(vars) {
  return { siteName: await settings.get('general.companyName'), time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), ...vars };
}

// Milliseconds until the quiet window ends, or 0 when outside it (IST).
async function quietDelayMs(now = new Date()) {
  const window = await settings.get('notify.quietHours'); // "21:00-08:00"
  const [from, to] = window.split('-').map((t) => t.split(':').map(Number));
  const ist = new Date(now.getTime() + 330 * 60000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const start = from[0] * 60 + from[1];
  const end = to[0] * 60 + to[1];
  const inQuiet = start > end ? mins >= start || mins < end : mins >= start && mins < end;
  if (!inQuiet) return 0;
  const wait = (end - mins + 1440) % 1440;
  return wait * 60000;
}

async function notifyUser({ user, event, vars = {}, channels = ['in_app'] }) {
  const def = DEFAULTS[event] || {};
  const v = await baseVars({ name: user.name, ...vars });
  const prefs = (user.notificationPrefs || {})[def.category] || {};
  const allowed = (ch) => def.transactional || prefs[ch] !== false;
  const out = {};

  if (channels.includes('in_app') && allowed('in_app')) {
    const t = await template(event, 'in_app');
    if (t) {
      out.in_app = await Notification.create({
        userId: user._id, eventKey: event, category: def.category || 'account', title: render(t.title, v), body: render(t.body, v), link: render(t.link, v),
      });
    }
  }
  if (channels.includes('email') && user.email && allowed('email')) {
    const t = await template(event, 'email');
    if (t) out.email = await jobs.enqueue('notify.email', { to: user.email, subject: render(t.subject, v), text: render(t.body, v) });
  }
  if (channels.includes('sms') && user.phone && user.phone.startsWith('+91') && allowed('sms')) { // SMS only to Indian numbers
    const t = await template(event, 'sms');
    if (t) {
      const delayMs = t.urgent ? 0 : await quietDelayMs();
      out.sms = await jobs.enqueue('notify.sms', { to: user.phone, text: render(t.body, v), templateId: t.dltTemplateId }, { delayMs });
    }
  }
  return out;
}

// Immediate delivery (OTPs). Falls back to email when SMS fails and a
// fallback address is given. Returns the channel actually used.
async function sendNow({ channel, to, event, vars = {}, fallbackEmail }) {
  const v = await baseVars(vars);
  if (channel === 'sms') {
    const t = await template(event, 'sms');
    try {
      await notify.sendSms({ to, text: render(t.body, v), templateId: t.dltTemplateId });
      return 'sms';
    } catch (err) {
      if (!fallbackEmail) throw err;
      return sendNow({ channel: 'email', to: fallbackEmail, event, vars });
    }
  }
  const t = await template(event, 'email');
  await notify.sendEmail({ to, subject: render(t.subject, v), text: render(t.body, v) });
  return 'email';
}

// In-app (and optional email) to every active staff member holding a permission
// (super admins always included). Managers are included when they hold the key.
async function notifyPermission(permission, event, vars = {}, channels = ['in_app']) {
  const { User } = require('../auth/models');
  const staff = await User.find({ status: 'active', $or: [{ role: 'superadmin' }, { role: { $in: ['admin', 'manager'] }, permissions: permission }] });
  for (const u of staff) await notifyUser({ user: u, event, vars, channels });
  return staff.length;
}

module.exports = { notifyUser, notifyPermission, sendNow, render, template, quietDelayMs, DEFAULTS };
