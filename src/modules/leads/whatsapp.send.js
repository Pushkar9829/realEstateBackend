// Outbound WhatsApp template sends for agents (RE-K-08, workflow K2 step 5).
// Uses the core/notify WhatsApp transport: console in development, captured in
// core/notify `sent` (channel 'whatsapp') in tests, and the Meta Cloud API
// when WHATSAPP_PROVIDER=meta. `template` is the agent template key
// (share_listing, visit_confirmation); the approved Meta template name,
// language and parameter order come from the whatsapp.<key> notification template.
const notify = require('../../core/notify');

async function sendWhatsapp({ to, text, template, vars = {} }) {
  const { template: load } = require('../notifications/service');
  const t = await load(`whatsapp.${template}`, 'whatsapp');
  const meta = t && t.waTemplateName ? { name: t.waTemplateName, language: t.language, params: t.params.map((k) => (vars[k] !== undefined ? String(vars[k]) : '')) } : null;
  return notify.sendWhatsapp({ to, text, template: meta });
}

module.exports = { sendWhatsapp };
