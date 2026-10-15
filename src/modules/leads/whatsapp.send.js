// Outbound WhatsApp template sends for agents (RE-K-08). core/notify has no
// WhatsApp transport yet, so this logs like the SMS console provider; in tests
// messages are captured in core/notify `sent` (channel 'whatsapp').
// The Meta Cloud API transport (WHATSAPP_PROVIDER=meta) is not built yet and
// falls back to the console as well.
const env = require('../../config/env');
const logger = require('../../core/logger');
const { sent } = require('../../core/notify');

async function sendWhatsapp({ to, text, template }) {
  if (env.isTest) {
    sent.push({ channel: 'whatsapp', to, text, template });
    return { provider: 'test' };
  }
  logger.info({ to, template, text }, '[whatsapp:console]');
  return { provider: 'console' };
}

module.exports = { sendWhatsapp };
