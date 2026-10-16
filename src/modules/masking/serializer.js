// Module B - public serializers (workflow B1, RE-B-01/02/03/13). Public
// responses are built ONLY from this allow-list: lister identity, unit number,
// address line, exact pin, ownership proofs, commission and agreement never
// leave the API through a public endpoint.
const settings = require('../../core/settings');

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const BADGE_LABEL = { owner: 'Verified Owner', landlord: 'Verified Landlord', builder: 'Verified Builder' };

function listerBadge(lister) {
  if (!lister) return 'Verified Lister';
  const base = BADGE_LABEL[lister.listerType] || 'Verified Lister';
  return lister.listerType === 'builder' && lister.brand && lister.brand.approved && lister.brand.name ? `${base} · ${lister.brand.name}` : base; // RE-B-02: "Verified Builder · <brand>" once approved
}

// RE-B-13: badges computed from listing and lister data, each with a tooltip that never names anyone.
function badges(p, lister, now = new Date()) {
  const out = [];
  if (lister && lister.kyc && lister.kyc.status === 'verified') {
    out.push({ code: 'verified_lister', label: listerBadge(lister), verifiedAt: p.liveAt, tooltip: `Our team checked the ${lister.listerType || 'lister'}'s ID and ownership documents before this listing went live on ${fmtDate(p.liveAt)}.` });
  }
  const ph = p.verification && p.verification.photo;
  if (ph && ph.status === 'verified' && (!ph.expiresAt || new Date(ph.expiresAt) > now)) {
    out.push({ code: 'photo_verified', label: 'Photo verified', verifiedAt: ph.verifiedAt, tooltip: `Photos taken at the property with a location check on ${fmtDate(ph.verifiedAt)} and reviewed by our team.` });
  }
  const st = p.verification && p.verification.site;
  if (st && st.status === 'verified' && (!st.expiresAt || new Date(st.expiresAt) > now)) {
    out.push({ code: 'site_verified', label: 'Site verified', verifiedAt: st.verifiedAt, tooltip: `Our field team visited this property on ${fmtDate(st.verifiedAt)}.` });
  }
  if (p.rera && (p.rera.numbers || []).length) {
    out.push({ code: 'rera', label: 'RERA registered', tooltip: `RERA number ${p.rera.numbers.join(', ')} - check it on the official RERA website.` });
  }
  return out;
}

const isVerified = (p, now = new Date()) => badges(p, null, now).some((b) => b.code === 'photo_verified' || b.code === 'site_verified');

function publicMedia(m = {}) {
  const ok = (ph) => !ph.moderation || ph.moderation.status !== 'rejected';
  return {
    photos: (m.photos || []).filter(ok).sort((a, b) => (b.isCover ? 1 : 0) - (a.isCover ? 1 : 0) || (a.sort || 0) - (b.sort || 0))
      .map((ph) => ({ url: ph.url, thumbUrl: ph.thumbUrl, caption: ph.caption, tag: ph.tag, isCover: Boolean(ph.isCover) })),
    floorPlans: (m.floorPlans || []).map((f) => ({ url: f.url, label: f.label })),
    video: m.video && m.video.kind === 'youtube' ? { kind: 'youtube', url: m.video.url } : m.video && m.video.url ? { kind: 'upload', url: m.video.url } : undefined,
    hasBrochure: Boolean(m.brochure && m.brochure.url),
  };
}

function point(p, s) {
  const geo = s['public.locationPrecision'] === 'exact' ? (p.location && p.location.geo) : (p.location && p.location.publicGeo);
  if (!geo || !geo.coordinates) return undefined;
  return { lat: geo.coordinates[1], lng: geo.coordinates[0], precision: s['public.locationPrecision'], radiusM: s['public.locationPrecision'] === 'exact' ? 0 : s['public.approxRadiusMeters'] };
}

// Card shape for lists, map popups, similar and compare.
function toPublicCard(p, lister, s) {
  const cover = publicMedia(p.media).photos[0];
  return {
    id: String(p._id), listingNo: p.listingNo, slug: p.slug, purpose: p.purpose, category: p.category, type: p.type, title: p.title,
    locality: p.location && p.location.locality, city: p.location && p.location.city,
    societyName: s['public.showSocietyName'] ? p.location && p.location.societyName : undefined,
    price: p.price ? { amount: p.price.amount, monthlyRent: p.price.monthlyRent, deposit: p.price.deposit, pricePerSqft: p.price.pricePerSqft, negotiable: p.price.negotiable } : undefined,
    bhk: p.details && p.details.bhk, baths: p.details && p.details.baths, areaSqft: p.details && p.details.areaSqft, furnishing: p.details && p.details.furnishing,
    possession: p.details && p.details.possession && p.details.possession.status,
    cover: cover ? { url: cover.thumbUrl || cover.url } : undefined, photoCount: (p.media && p.media.photos || []).length,
    listerBadge: listerBadge(lister), badges: badges(p, lister).map(({ code, label }) => ({ code, label })),
    featured: Boolean(p.featured && p.featured.on && (!p.featured.until || new Date(p.featured.until) > new Date())),
    point: point(p, s), postedAt: p.liveAt,
  };
}

// Full masked detail (RE-S-PUB-04).
function toPublicProperty(p, lister, s) {
  return {
    ...toPublicCard(p, lister, s),
    description: p.description,
    details: p.details ? {
      bhk: p.details.bhk, baths: p.details.baths, balconies: p.details.balconies, areas: p.details.areas, areaSqft: p.details.areaSqft,
      floor: p.details.floor, totalFloors: p.details.totalFloors, furnishing: p.details.furnishing, facing: p.details.facing, ageYears: p.details.ageYears,
      possession: p.details.possession, parking: p.details.parking,
    } : undefined,
    price: p.price ? { amount: p.price.amount, monthlyRent: p.price.monthlyRent, deposit: p.price.deposit, maintenance: p.price.maintenance, pricePerSqft: p.price.pricePerSqft, negotiable: p.price.negotiable, allInclusive: p.price.allInclusive } : undefined,
    amenities: p.amenities || [],
    landmarks: (p.location && p.location.landmarks || []).map((l) => ({ type: l.type, name: l.name, distanceKm: l.distanceKm })),
    media: publicMedia(p.media),
    badges: badges(p, lister),
    rera: p.rera && ((p.rera.numbers || []).length || (p.rera.exempt && p.rera.exempt.reason))
      ? { numbers: p.rera.numbers || [], state: p.rera.state, url: p.rera.url, exemptReason: p.rera.exempt && p.rera.exempt.reason }
      : undefined,
    availabilityConfirmedAt: (p.availability && p.availability.lastConfirmedAt) || p.liveAt,
    stats: { views: (p.stats && p.stats.views) || 0 },
    hotline: s['general.hotlineNumber'],
    whatsapp: s['general.whatsappNumber'] || undefined,
  };
}

const LISTER_FIELDS = 'listerType brand kyc.status';
const loadSettings = () => settings.all();

module.exports = { toPublicCard, toPublicProperty, badges, isVerified, listerBadge, LISTER_FIELDS, loadSettings };
