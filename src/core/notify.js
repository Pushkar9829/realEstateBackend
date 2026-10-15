// Outbound email and SMS transports. In development (no SMTP / SMS keys)
// messages, including OTPs, are printed to the console instead. In tests
// they are captured in memory (`sent`) so tests can read OTPs.
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

module.exports = { sendEmail, sendSms, sent };
