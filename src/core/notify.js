// Outbound email, SMS and WhatsApp transports. In development (no SMTP / SMS
// keys, WHATSAPP_PROVIDER=console) messages, including OTPs, are printed to the
// console instead. In tests they are captured in memory (`sent`) so tests can
// read OTPs.
// Callers normally go through the notifications module, which renders
// templates and decides between immediate sends and queued jobs.
const nodemailer = require('nodemailer');
const axios = require('axios');
const env = require('../config/env');
const logger = require('./logger');

const sent = []; // test capture: { channel, to, subject?, text }

let transporter;
function mailer() {
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  if (env.isTest) {
    sent.push({ channel: 'email', to, subject, text: text || html });
    return { provider: 'test' };
  }
  const t = mailer();
  if (!t) {
    logger.info({ to, subject, text: text || html }, '[email:console]');
    return { provider: 'console' };
  }
  const info = await t.sendMail({ from: env.SMTP_FROM, to, subject, html, text });
  return { provider: 'smtp', id: info.messageId };
}

const smsProviders = {
  console: async ({ to, text }) => {
    logger.info({ to, text }, '[sms:console]');
    return { provider: 'console' };
  },
  msg91: async ({ to, text, templateId }) => {
    const res = await axios.post('https://control.msg91.com/api/v5/flow/', {
      template_id: templateId, short_url: '0', recipients: [{ mobiles: to.replace('+', ''), message: text }],
    }, { headers: { authkey: env.MSG91_AUTH_KEY }, timeout: 10000 });
    return { provider: 'msg91', id: res.data && res.data.request_id };
  },
  twilio: async ({ to, text }) => {
    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text }),
      { auth: { username: env.TWILIO_ACCOUNT_SID, password: env.TWILIO_AUTH_TOKEN }, timeout: 10000 },
    );
    return { provider: 'twilio', id: res.data.sid };
  },
};

async function sendSms(msg) {
  if (env.isTest) {
    if (sendSms.failNext) { sendSms.failNext = false; throw new Error('SMS provider unavailable (test)'); }
    sent.push({ channel: 'sms', to: msg.to, text: msg.text });
    return { provider: 'test' };
  }
  return smsProviders[env.SMS_PROVIDER](msg);
}

// WhatsApp (RE-K-08). Meta Cloud API directly, no BSP. Outside the 24-hour
// customer-service window only approved templates may be sent, so callers pass
// `template` { name, language, params } (body parameters in order) and optional
// quick-reply `buttons` [{ title, payload }]; without a template the plain
// `text` is sent (inside the window only).
const WA_API_VERSION = env.WHATSAPP_API_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0';

function metaBody({ to, text, template, buttons = [] }) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to).replace(/\D/g, '') };
  if (!template || !template.name) return { ...base, type: 'text', text: { preview_url: false, body: text } };
  const components = [];
  if ((template.params || []).length) components.push({ type: 'body', parameters: template.params.map((v) => ({ type: 'text', text: String(v) })) });
  buttons.forEach((b, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: b.payload }] }));
  return { ...base, type: 'template', template: { name: template.name, language: { code: template.language || 'en' }, ...(components.length ? { components } : {}) } };
}

const waProviders = {
  console: async ({ to, text, template, buttons }) => {
    logger.info({ to, template: template && template.name, text, buttons: (buttons || []).map((b) => b.payload) }, '[whatsapp:console]');
    return { provider: 'console' };
  },
  meta: async (msg) => {
    if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) throw new Error('WhatsApp Cloud API is not configured');
    const res = await axios.post(`https://graph.facebook.com/${WA_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, metaBody(msg), {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000,
    });
    return { provider: 'meta', id: res.data && res.data.messages && res.data.messages[0] && res.data.messages[0].id };
  },
};

async function sendWhatsapp(msg) {
  if (env.isTest) {
    if (sendWhatsapp.failNext) { sendWhatsapp.failNext = false; throw new Error('WhatsApp provider unavailable (test)'); }
    sent.push({ channel: 'whatsapp', to: msg.to, text: msg.text, template: msg.template, buttons: msg.buttons });
    return { provider: 'test' };
  }
  return (waProviders[env.WHATSAPP_PROVIDER] || waProviders.console)(msg);
}

module.exports = { sendEmail, sendSms, sendWhatsapp, metaBody, sent };
