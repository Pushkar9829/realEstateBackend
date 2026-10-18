// Module K - notification service used by every module.
//
//   notify({ userId, event, vars, channels, to })    in-app now; email/SMS/WhatsApp queued as jobs
//   sendNow({ channel, to, event, vars })            immediate send (OTPs), returns the channel used
//   notifyLeadBuyer(lead, { event, vars, channels }) the buyer of a lead (registered or guest)
//
// Templates: admin override (NotificationTemplate) > default (templates.js).
// Non-urgent SMS falling in quiet hours (notifications.smsQuietHours) are
// delayed until the window ends.
//
// WhatsApp (RE-K-08, workflow K2): when whatsapp.enabled is on, the event is in
// whatsapp.events and the recipient opted in (consent ledger, purpose
// whatsapp_updates), the text message goes by WhatsApp (job notify.whatsapp)
// instead of SMS, and a failed WhatsApp send falls back to that SMS. A
// recipient who did not opt in never gets a notify.whatsapp job.
const { Notification, NotificationTemplate } = require('./models');
const DEFAULTS = require('./templates');
const jobs = require('../../core/jobs');
const notify = require('../../core/notify');
const settings = require('../../core/settings');
const logger = require('../../core/logger');
const { istDateTime } = require('../../core/format');

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
    // WhatsApp: approved template name (admin override wins), language, body parameter order, quick replies.
    waTemplateName: (override && override.waTemplateName) || (def && def.name),
    language: (def && def.language) || 'en',
    params: (def && def.params) || [],
    buttons: (def && def.buttons) || [],
  };
}

async function baseVars(vars) {
  return { siteName: await settings.get('general.companyName'), time: istDateTime(new Date()), ...vars };
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

// ---------------------------------------------------------------- WhatsApp (RE-K-08)

// Short names the whatsapp.events setting may use for template keys (either works).
const WA_EVENT_ALIASES = {
  'lead.created': 'lead.received',
  'sitevisit.scheduled': 'visit.scheduled',
  'sitevisit.rescheduled': 'visit.scheduled',
  'sitevisit.reminder': 'visit.reminder',
  'sitevisit.feedback_request': 'visit.feedback',
  'listing.availability_check': 'listing.check',
};

async function whatsappEnabledFor(event) {
  const s = await settings.all();
  if (!s['whatsapp.enabled']) return false;
  const list = s['whatsapp.events'] || [];
  return list.includes(event) || Boolean(WA_EVENT_ALIASES[event] && list.includes(WA_EVENT_ALIASES[event]));
}

// Opt-in from the consent ledger (RE-M-10): the latest whatsapp_updates give or
// withdrawal across the subjects (user, buyer contact) decides. Without any
// record, `fallback` (the lead's enquiry checkbox) applies.
async function whatsappOptedIn(subjectIds, fallback = false) {
  const ids = (subjectIds || []).filter(Boolean);
  if (!ids.length) return Boolean(fallback);
  const { Consent } = require('../auth/models');
  const rows = await Consent.find({ subjectId: { $in: ids }, purpose: 'whatsapp_updates' }).select('givenAt withdrawnAt').lean();
  if (!rows.length) return Boolean(fallback);
  let last = null;
  for (const r of rows) {
    for (const [at, optedIn] of [[r.givenAt, true], [r.withdrawnAt, false]]) {
      if (at && (!last || new Date(at) >= last.at)) last = { at: new Date(at), optedIn };
    }
  }
  return Boolean(last && last.optedIn);
}

// The "still available?" token sits in the check link (/listing-check/<token>);
// quick replies carry check:<token>:<answer>, applied by the inbound webhook.
const checkToken = (vars) => vars.checkToken || (/\/listing-check\/([^/?#\s]+)/.exec(vars.link || '') || [])[1] || '';

async function queueWhatsapp({ to, event, vars, delayMs = 0, fallbackSms = null }) {
  const t = await template(event, 'whatsapp');
  if (!t || !to) return null;
  const v = { ...vars, checkToken: checkToken(vars) };
  return jobs.enqueue('notify.whatsapp', {
    to,
    event,
    text: render(t.body, v),
    template: t.waTemplateName ? { name: t.waTemplateName, language: t.language, params: t.params.map((k) => (v[k] !== undefined ? String(v[k]) : '')) } : null,
    buttons: t.buttons.map((b) => ({ title: b.title, payload: render(b.payload, v) })),
    fallbackSms,
  }, { delayMs });
}

// Job handler (notify.whatsapp): when the send fails the SMS fallback goes now,
// or as its own notify.sms job when SMS fails as well. Without a fallback the job retries.
async function deliverWhatsapp(p) {
  try {
    return await notify.sendWhatsapp(p);
  } catch (err) {
    if (!p.fallbackSms) throw err;
    logger.warn({ event: p.event, err: err.message }, 'WhatsApp send failed, falling back to SMS');
    try { await notify.sendSms(p.fallbackSms); } catch { await jobs.enqueue('notify.sms', p.fallbackSms); }
    return { provider: 'sms_fallback' };
  }
}

// ---------------------------------------------------------------- recipients

async function notifyUser({ user, event, vars = {}, channels = ['in_app'], whatsappOptIn }) {
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
  const smsOk = channels.includes('sms') && user.phone && user.phone.startsWith('+91') && allowed('sms'); // SMS only to Indian numbers
  if ((channels.includes('sms') || channels.includes('whatsapp')) && user.phone && allowed('whatsapp') && await whatsappEnabledFor(event)) {
    const optedIn = typeof whatsappOptIn === 'boolean' ? whatsappOptIn : await whatsappOptedIn([user._id]);
    if (optedIn) {
      const smsT = smsOk ? await template(event, 'sms') : null;
      const fallbackSms = smsT ? { to: user.phone, text: render(smsT.body, v), templateId: smsT.dltTemplateId } : null;
      out.whatsapp = await queueWhatsapp({ to: user.phone, event, vars: v, delayMs: smsT && smsT.urgent ? 0 : await quietDelayMs(), fallbackSms });
    }
  }
  if (smsOk && !out.whatsapp) {
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

// Buyer of a lead: a registered buyer through notifyUser; a guest by WhatsApp
// when opted in (SMS fallback), otherwise an immediate SMS as before (or email
// for a foreign number when guestChannel is 'auto'). Buyer texts never carry
// lister data (RE-B-05).
async function notifyLeadBuyer(lead, { event, vars = {}, channels = ['in_app', 'email', 'sms'], guestChannel = 'sms' }) {
  const { User } = require('../auth/models');
  const buyer = lead.buyer || {};
  const waOn = await whatsappEnabledFor(event);
  const optIn = waOn ? await whatsappOptedIn([buyer.userId, buyer.contactId], lead.whatsappOptIn) : false;
  if (buyer.userId) {
    const u = await User.findById(buyer.userId);
    return u ? notifyUser({ user: u, event, vars, channels, whatsappOptIn: optIn }) : null;
  }
  if (!buyer.phone) return null;
  const indian = buyer.phone.startsWith('+91');
  if (optIn) {
    const v = await baseVars({ name: buyer.name, ...vars });
    const smsT = indian ? await template(event, 'sms') : null;
    const fallbackSms = smsT ? { to: buyer.phone, text: render(smsT.body, v), templateId: smsT.dltTemplateId } : null;
    const job = await queueWhatsapp({ to: buyer.phone, event, vars: v, delayMs: smsT && smsT.urgent ? 0 : await quietDelayMs(), fallbackSms });
    if (job) return { whatsapp: job };
  }
  const channel = guestChannel === 'auto' && !indian ? 'email' : 'sms';
  const to = channel === 'email' ? buyer.email : buyer.phone;
  if (!to) return null;
  return sendNow({ channel, to, event, vars, fallbackEmail: buyer.email }).catch(() => null);
}

// In-app (and optional email) to every active staff member holding a permission
// (super admins always included). Managers are included when they hold the key.
async function notifyPermission(permission, event, vars = {}, channels = ['in_app']) {
  const { User } = require('../auth/models');
  const staff = await User.find({ status: 'active', $or: [{ role: 'superadmin' }, { role: { $in: ['admin', 'manager'] }, permissions: permission }] });
  for (const u of staff) await notifyUser({ user: u, event, vars, channels });
  return staff.length;
}

module.exports = {
  notifyUser, notifyPermission, notifyLeadBuyer, sendNow, render, template, quietDelayMs, DEFAULTS,
  whatsappEnabledFor, whatsappOptedIn, queueWhatsapp, deliverWhatsapp, WA_EVENT_ALIASES,
};
