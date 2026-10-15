// RE-B-06 contact-info guard: free text written by listers (and buyers in
// messages) must not carry phone numbers, emails, links or "call me"
// phrases, otherwise the no-broker / masking promise breaks. Every hit is
// logged as a security event (broker rule R6 counts them).
const { ApiError } = require('../../core/http');
const settings = require('../../core/settings');
const { securityEvent } = require('../../core/audit');

const PHONE = /(?:\+?\d[\s-.()]*){10,}/; // 10+ digits allowing separators
const EMAIL = /[A-Z0-9._%+-]+\s*(?:@|\(at\)|\[at\])\s*[A-Z0-9.-]+\s*(?:\.|\(dot\)|\[dot\])\s*[A-Z]{2,}/i;
const URL = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|in|net|org|co|io|me|ly)\b(?:\/\S*)?/i;

async function findContactInfo(text) {
  if (!text) return [];
  const hits = [];
  if (PHONE.test(text)) hits.push('phone');
  if (EMAIL.test(text)) hits.push('email');
  if (URL.test(text)) hits.push('link');
  const phrases = (await settings.get('guard.blockedPhrases')) || [];
  const lower = text.toLowerCase();
  phrases.forEach((p) => { if (lower.includes(String(p).toLowerCase())) hits.push(`phrase:${p}`); });
  return hits;
}

// Throws 422 CONTACT_INFO_BLOCKED naming the fields; logs one event per call.
async function assertNoContactInfo(fields, req) {
  const details = [];
  for (const [path, text] of Object.entries(fields)) {
    const hits = await findContactInfo(text);
    if (hits.length) details.push({ in: 'body', path, message: `Remove contact details (${hits.join(', ')}). Buyers reach you through our sales team.` });
  }
  if (details.length) {
    await securityEvent(req, 'guard.blocked', { userId: req.user && req.user._id, meta: { fields: details.map((d) => d.path) } });
    if (req.user && req.user.role === 'lister') await require('../kyc/service').checkGuardHits(req.user._id); // broker rule R6
    throw new ApiError(422, 'CONTACT_INFO_BLOCKED', 'Contact details are not allowed in listing text', details);
  }
}

module.exports = { findContactInfo, assertNoContactInfo };
