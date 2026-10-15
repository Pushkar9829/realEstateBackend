// Module B - Identity & Contact Masking: public panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('B', [
  'maskedDetail', // GET /api/properties/:slug - Masked detail
  'hotlinePrecisionMin', // GET /api/settings/public - Hotline, precision, min %
  'reportAListing', // POST /api/properties/:id/report - Report a listing
  'countWhatsappClicks', // POST /api/properties/:id/whatsapp-click - Count WhatsApp clicks
]);

// ---- Phase 1: public settings (only safe, non-personal values) ----
const { asyncHandler, ok } = require('../../../core/http');
const settings = require('../../../core/settings');

Object.assign(module.exports, {
  // GET /api/settings/public
  hotlinePrecisionMin: asyncHandler(async (req, res) => {
    const s = await settings.all();
    ok(res, {
      companyName: s['general.companyName'],
      hotline: s['general.hotlineNumber'],
      whatsappNumber: s['general.whatsappNumber'],
      supportEmail: s['general.supportEmail'],
      helpdeskUrl: s['general.helpdeskUrl'],
      defaultCity: s['public.defaultCity'],
      locationPrecision: s['public.locationPrecision'],
      commission: {
        sale: { min: s['commission.minPercent.sale'], max: s['commission.maxPercent.sale'] },
        rent: { min: s['commission.minPercent.rent'], max: s['commission.maxPercent.rent'], basisMonths: s['commission.rentBasisMonths'] },
      },
      rera: { agentRegistrations: s['rera.agentRegistrations'], showQr: s['rera.showQr'] },
      privacy: { noticeVersion: s['privacy.noticeVersion'], grievanceOfficer: s['privacy.grievanceOfficer'] },
      consent: { bannerEnabled: s['consent.bannerEnabled'], cookieDays: s['consent.cookieDays'], ga4MeasurementId: s['analytics.ga4MeasurementId'] },
      referral: { captureDays: s['mlm.refCaptureDays'] },
      languages: s['i18n.languages'],
      calc: { interestRate: s['calc.defaultInterestRate'], tenureYears: s['calc.defaultTenureYears'], loanPercent: s['calc.defaultLoanPercent'], foirPercent: s['calc.foirPercent'], downPaymentPercent: s['calc.downPaymentPercent'] },
      visit: { dayStart: s['visit.dayStart'], dayEnd: s['visit.dayEnd'], minLeadHours: s['visit.minLeadHours'], slotMinutes: s['visit.slotMinutes'], horizonDays: s['visit.horizonDays'] },
      features: { whatsapp: s['whatsapp.enabled'], guestOtp: s['lead.requireOtpForGuest'], nlSearch: s['nlsearch.enabled'], verifiedFilter: s['search.showVerifiedFilter'], loanReferral: s['partners.loanReferralEnabled'] },
    });
  }),
});

// ---- Phase 3: masked detail, report, WhatsApp click (spec 4.2) ----
const search = require('../../search/service');
const { Property } = require('../../listings/models');

const RESERVED = new Set(['map', 'near', 'autocomplete']);

Object.assign(module.exports, {
  // GET /api/properties/:slug - the search module owns /properties/map|near|autocomplete
  maskedDetail: asyncHandler(async (req, res, next) => {
    if (RESERVED.has(req.params.slug)) return next();
    return ok(res, await search.detail(req.params.slug));
  }),
  reportAListing: asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await search.reportListing(req.params.id, req.body, req) })),
  countWhatsappClicks: asyncHandler(async (req, res) => {
    const p = await search.liveBySlugOrId(req.params.id);
    await Property.updateOne({ _id: p._id }, { $inc: { 'stats.whatsappClicks': 1 } });
    const s = await settings.all();
    const number = String(s['general.whatsappNumber'] || '').replace(/\D/g, '');
    const text = `Hi, I am interested in ${p.listingNo}: ${p.title}`;
    ok(res, { url: number ? `https://wa.me/${number}?text=${encodeURIComponent(text)}` : null });
  }),
});

// ---- Phase 7: RERA QR code (RE-G-08, RE-S-PUB-04/05) ----
const QRCode = require('qrcode');
const { ApiError } = require('../../../core/http');

// Only https URLs on the RERA hosts in `rera.urlHosts` (or any *.gov.in host
// when that list is empty) are turned into a QR code.
async function reraUrlOrThrow(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { u = null; }
  if (!u || String(raw).length > 500 || u.protocol !== 'https:' || u.username || u.password) throw ApiError.badRequest('A valid https RERA URL is required', 'INVALID_RERA_URL');
  const host = u.hostname.toLowerCase();
  const hosts = ((await settings.get('rera.urlHosts')) || []).map((x) => String(x).toLowerCase());
  const allowed = hosts.length ? hosts.includes(host) : (host === 'gov.in' || host.endsWith('.gov.in'));
  if (!allowed) throw ApiError.badRequest('This URL is not on an official RERA website', 'RERA_HOST_NOT_ALLOWED');
  return u.toString();
}

Object.assign(module.exports, {
  // GET /api/rera/qr?url=<https url>&size=<120-600> - PNG
  reraQr: asyncHandler(async (req, res) => {
    const url = await reraUrlOrThrow(req.query.url);
    const size = Math.min(600, Math.max(120, parseInt(req.query.size, 10) || 240));
    const png = await QRCode.toBuffer(url, { type: 'png', width: size, margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800', 'X-Content-Type-Options': 'nosniff' });
    res.send(png);
  }),
  reraUrlOrThrow,
});
