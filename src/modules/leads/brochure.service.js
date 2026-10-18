// RE-A-07 brochure download on the public property and project pages.
// With `public.brochureGated` (default on) the brochure is released only to a
// buyer who has enquired on that property / project: a signed-in buyer with a
// lead there, or a guest presenting the phone-verified guest token (the
// otpToken from the enquiry, sent in the X-Guest-Token header, never in the
// URL). Without gating any visitor gets it. Returns { url, name }.
const { Lead } = require('./models');
const { Property } = require('../listings/models');
const jwt = require('../../core/security/jwt');
const settings = require('../../core/settings');
const { ApiError } = require('../../core/http');

async function target(kind, slug) {
  if (kind === 'project') {
    const { Project } = require('../projects/models');
    const p = await Project.findOne({ slug, status: { $in: ['live', 'sold_out'] } }).select('name projectNo media.brochure').lean();
    return p && { key: { projectId: p._id }, brochure: p.media && p.media.brochure, name: p.name || p.projectNo };
  }
  const p = await Property.findOne({ slug, status: 'live', deletedAt: null }).select('title listingNo media.brochure').lean();
  return p && { key: { propertyId: p._id }, brochure: p.media && p.media.brochure, name: p.title || p.listingNo };
}

function guestPhone(req) {
  const token = req.get('x-guest-token');
  if (!token) return null;
  try { return jwt.verify(token, 'guest').sub; } catch { return null; }
}

async function brochure(kind, slug, req) {
  const t = await target(kind, String(slug || ''));
  if (!t || !t.brochure || !t.brochure.url) throw ApiError.notFound('No brochure for this listing');
  const gated = await settings.get('public.brochureGated').catch(() => true);
  if (gated) {
    const who = [];
    if (req.user) who.push({ 'buyer.userId': req.user._id }, ...(req.user.phone ? [{ 'buyer.phone': req.user.phone }] : []));
    const phone = guestPhone(req);
    if (phone) who.push({ 'buyer.phone': phone });
    const enquired = who.length > 0 && await Lead.exists({ ...t.key, $or: who });
    if (!enquired) throw ApiError.forbidden('Send an enquiry to get the brochure', 'ENQUIRE_FIRST');
  }
  return { url: t.brochure.url, name: `${t.name} - brochure` };
}

module.exports = { brochure };
