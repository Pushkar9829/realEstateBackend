// Module E - Search & Discovery (spec 4.5, workflows E1-E5): filtered search,
// map and near-me on public coordinates, autocomplete, similar, compare, view
// counting, shortlist, saved searches with alerts, landing pages, locality
// trends, the rule-based sentence parser and reported listings.
// Prices in query strings are rupees; stored prices are paise.
const crypto = require('crypto');
const { z } = require('zod');
const { Property } = require('../listings/models');
const { Master } = require('../cms/models');
const { User } = require('../auth/models');
const { Shortlist, SavedSearch, PropertyView, ListingReport, LocalityTrend } = require('./models');
const serializer = require('../masking/serializer');
const settings = require('../../core/settings');
const counters = require('../../core/counters');
const env = require('../../config/env');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser, notifyPermission } = require('../notifications/service');

const PAGE_MAX = 50;
const COUNT_CAP = 10000;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csv = (v) => (v === undefined || v === '' ? undefined : String(v).split(',').map((x) => x.trim()).filter(Boolean));
const oid = /^[a-f0-9]{24}$/;

// ---------------------------------------------------------------- query -> filter (E1)

const filterSchema = z.object({
  purpose: z.enum(['sale', 'rent']).optional(),
  city: z.string().trim().max(60).optional(),
  localities: z.string().optional(),
  category: z.enum(['residential', 'commercial', 'land']).optional(),
  types: z.string().optional(),
  bhk: z.string().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minArea: z.coerce.number().min(0).optional(),
  maxArea: z.coerce.number().min(0).optional(),
  furnishing: z.string().optional(),
  possession: z.enum(['ready', 'under_construction']).optional(),
  amenities: z.string().optional(),
  postedBy: z.enum(['owner', 'builder', 'landlord']).optional(),
  verified: z.union([z.literal('1'), z.literal('true'), z.literal(true), z.literal(1)]).optional(),
  q: z.string().trim().max(120).optional(),
}).passthrough();

async function resolveCity(key) {
  if (!key) return null;
  return Master.findOne({ type: 'city', ...(oid.test(key) ? { _id: key } : { $or: [{ code: key.toLowerCase() }, { slug: key.toLowerCase() }, { name: new RegExp(`^${esc(key)}$`, 'i') }] }) }).lean();
}

async function resolveLocalities(list, cityId) {
  if (!list || !list.length) return null;
  const ids = list.filter((x) => oid.test(x));
  const codes = list.filter((x) => !oid.test(x)).map((x) => x.toLowerCase());
  const rows = await Master.find({ type: 'locality', ...(cityId ? { parentId: cityId } : {}), $or: [{ _id: { $in: ids } }, { code: { $in: codes } }, { slug: { $in: codes } }] }).select('_id').lean();
  return rows.map((r) => r._id);
}

// Returns a Mongo filter on live listings plus the parsed filters (for echoing / alerts).
async function buildFilter(raw = {}) {
  const f = filterSchema.parse(raw);
  const filter = { status: 'live', deletedAt: null };
  if (f.purpose) filter.purpose = f.purpose;
  if (f.category) filter.category = f.category;
  const city = await resolveCity(f.city);
  if (f.city && !city) filter['location.cityId'] = null; // unknown city -> no results
  if (city) filter['location.cityId'] = city._id;
  const locs = await resolveLocalities(csv(f.localities), city && city._id);
  if (locs) filter['location.localityId'] = { $in: locs };
  if (csv(f.types)) filter.type = { $in: csv(f.types) };
  const bhk = csv(f.bhk);
  if (bhk) {
    // "4+" means 4 or more bedrooms.
    const exact = bhk.filter((b) => !b.endsWith('+')).map(Number).filter(Number.isInteger);
    const plus = bhk.filter((b) => b.endsWith('+')).map((b) => parseInt(b, 10)).filter(Number.isInteger);
    if (plus.length) filter.$and = [...(filter.$and || []), { $or: [{ 'details.bhk': { $in: exact } }, { 'details.bhk': { $gte: Math.min(...plus) } }] }];
    else filter['details.bhk'] = { $in: exact };
  }
  const priceField = f.purpose === 'rent' ? 'price.monthlyRent' : 'price.amount';
  if (f.minPrice !== undefined || f.maxPrice !== undefined) {
    filter[priceField] = { ...(f.minPrice !== undefined ? { $gte: f.minPrice * 100 } : {}), ...(f.maxPrice !== undefined ? { $lte: f.maxPrice * 100 } : {}) };
  }
  if (f.minArea !== undefined || f.maxArea !== undefined) {
    filter['details.areaSqft'] = { ...(f.minArea !== undefined ? { $gte: f.minArea } : {}), ...(f.maxArea !== undefined ? { $lte: f.maxArea } : {}) };
  }
  if (csv(f.furnishing)) filter['details.furnishing'] = { $in: csv(f.furnishing) };
  if (f.possession) filter['details.possession.status'] = f.possession;
  if (csv(f.amenities)) filter.amenities = { $all: csv(f.amenities) };
  if (f.postedBy) {
    const ids = await User.find({ role: 'lister', listerType: f.postedBy }).distinct('_id');
    filter.listerId = { $in: ids };
  }
  if (f.verified) {
    const now = new Date();
    const v = [
      { 'verification.photo.status': 'verified', $or: [{ 'verification.photo.expiresAt': null }, { 'verification.photo.expiresAt': { $gt: now } }] },
      { 'verification.site.status': 'verified', $or: [{ 'verification.site.expiresAt': null }, { 'verification.site.expiresAt': { $gt: now } }] },
    ];
    filter.$and = [...(filter.$and || []), { $or: v }];
  }
  if (f.q) filter.$text = { $search: f.q };
  return { filter, parsed: f, city };
}

const SORTS = {
  newest: { liveAt: -1 },
  price_asc: (purpose) => ({ [purpose === 'rent' ? 'price.monthlyRent' : 'price.amount']: 1 }),
  price_desc: (purpose) => ({ [purpose === 'rent' ? 'price.monthlyRent' : 'price.amount']: -1 }),
  ppsf_asc: { 'price.pricePerSqft': 1 },
  area_desc: { 'details.areaSqft': -1 },
};

async function listersFor(items) {
  const ids = [...new Set(items.map((p) => String(p.listerId)))];
  const rows = await User.find({ _id: { $in: ids } }).select(serializer.LISTER_FIELDS).lean();
  return Object.fromEntries(rows.map((u) => [String(u._id), u]));
}

async function cards(items) {
  const s = await settings.all();
  const listers = await listersFor(items);
  return items.map((p) => serializer.toPublicCard(p, listers[String(p.listerId)], s));
}

async function search(query) {
  const { filter, parsed } = await buildFilter(query);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(query.limit, 10) || 20));
  const sortKey = query.sort || 'relevance';
  let sort;
  let projection;
  if (sortKey === 'relevance') {
    sort = parsed.q ? { 'featured.on': -1, score: { $meta: 'textScore' }, liveAt: -1 } : { 'featured.on': -1, liveAt: -1 };
    if (parsed.q) projection = { score: { $meta: 'textScore' } };
  } else {
    const s = SORTS[sortKey];
    if (!s) throw ApiError.validation([{ in: 'query', path: 'sort', message: `Sort must be one of relevance, ${Object.keys(SORTS).join(', ')}` }]);
    sort = typeof s === 'function' ? s(parsed.purpose) : s;
  }
  const [items, total] = await Promise.all([
    Property.find(filter, projection).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Property.countDocuments(filter).limit(COUNT_CAP + 1),
  ]);
  return {
    items: await cards(items),
    meta: { page, limit, total: Math.min(total, COUNT_CAP), totalCapped: total > COUNT_CAP, pages: Math.ceil(Math.min(total, COUNT_CAP) / limit), facets: await facets(filter) },
  };
}

// BHK and verified counts for the current result set (Should).
async function facets(filter) {
  const base = { ...filter };
  delete base['details.bhk'];
  if (base.$text) return {}; // $text cannot be combined with $facet cheaply; skip facets for keyword searches
  const [row] = await Property.aggregate([
    { $match: base },
    { $facet: {
      bhk: [{ $group: { _id: '$details.bhk', n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
      verified: [{ $match: { $or: [{ 'verification.photo.status': 'verified' }, { 'verification.site.status': 'verified' }] } }, { $count: 'n' }],
    } },
  ]);
  return { bhk: (row.bhk || []).filter((b) => b._id != null).map((b) => ({ bhk: b._id, count: b.n })), verified: (row.verified[0] && row.verified[0].n) || 0 };
}

// ---------------------------------------------------------------- map and near me (RE-E-03/04)

async function map(query) {
  const b = z.object({ swLat: z.coerce.number(), swLng: z.coerce.number(), neLat: z.coerce.number(), neLng: z.coerce.number() }).parse(query);
  const { filter } = await buildFilter(query);
  delete filter.$text;
  filter['location.publicGeo'] = { $geoWithin: { $box: [[b.swLng, b.swLat], [b.neLng, b.neLat]] } };
  const total = await Property.countDocuments(filter);
  const s = await settings.all();
  if (total <= 500) {
    const items = await Property.find(filter).limit(500).lean();
    return { total, pins: await cards(items), clusters: [] };
  }
  // Grid clustering: ~24 x 24 cells over the box.
  const cellLat = (b.neLat - b.swLat) / 24;
  const cellLng = (b.neLng - b.swLng) / 24;
  const clusters = await Property.aggregate([
    { $match: filter },
    { $group: {
      _id: { y: { $floor: { $divide: [{ $subtract: [{ $arrayElemAt: ['$location.publicGeo.coordinates', 1] }, b.swLat] }, cellLat] } }, x: { $floor: { $divide: [{ $subtract: [{ $arrayElemAt: ['$location.publicGeo.coordinates', 0] }, b.swLng] }, cellLng] } } },
      n: { $sum: 1 }, lat: { $avg: { $arrayElemAt: ['$location.publicGeo.coordinates', 1] } }, lng: { $avg: { $arrayElemAt: ['$location.publicGeo.coordinates', 0] } },
      minPrice: { $min: { $ifNull: ['$price.amount', '$price.monthlyRent'] } },
    } },
    { $limit: 500 },
  ]);
  return { total, pins: [], clusters: clusters.map((c) => ({ lat: c.lat, lng: c.lng, count: c.n, minPrice: c.minPrice })), precision: s['public.locationPrecision'] };
}

async function near(query) {
  const p = z.object({ lat: z.coerce.number().min(6).max(37), lng: z.coerce.number().min(68).max(98), radiusKm: z.coerce.number().min(1).max(50).default(5) }).parse(query);
  const { filter } = await buildFilter(query);
  delete filter.$text;
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(query.limit, 10) || 20));
  const rows = await Property.aggregate([
    { $geoNear: { near: { type: 'Point', coordinates: [p.lng, p.lat] }, key: 'location.publicGeo', distanceField: 'distanceM', maxDistance: p.radiusKm * 1000, query: filter, spherical: true } },
    { $limit: limit },
  ]);
  const out = await cards(rows);
  return out.map((c, i) => ({ ...c, distanceKm: Math.round((rows[i].distanceM / 1000) * 2) / 2 })); // rounded to 0.5 km
}

// ---------------------------------------------------------------- detail helpers

async function liveBySlugOrId(key) {
  const p = await Property.findOne({ status: 'live', deletedAt: null, ...(oid.test(key) ? { _id: key } : { slug: key }) }).lean();
  if (!p) throw ApiError.notFound('Property not found or no longer available');
  return p;
}

// RE-S-PUB-04 states: sold, rented, expired, inactive and paused listings answer
// 410 LISTING_UNAVAILABLE with a minimal payload (no lister data, no price, no
// media) and live listings in the same locality and purpose. Anything else
// (never existed, deleted, draft, pending, rejected, suspended) stays 404.
const GONE = { sold: 'sold', rented: 'rented', expired: 'unavailable', inactive: 'unavailable', paused: 'unavailable' };

async function unavailable(slug) {
  if (oid.test(slug)) return null;
  const p = await Property.findOne({ slug, deletedAt: null, status: { $in: Object.keys(GONE) } })
    .select('title listingNo purpose status location.cityId location.city location.localityId location.locality').lean();
  if (!p) return null;
  const items = await Property.find({
    _id: { $ne: p._id }, status: 'live', deletedAt: null, purpose: p.purpose,
    ...(p.location && p.location.localityId ? { 'location.localityId': p.location.localityId } : { 'location.cityId': p.location && p.location.cityId }),
  }).sort({ liveAt: -1 }).limit(6).lean();
  const status = GONE[p.status];
  const message = status === 'sold' ? 'This property is sold' : status === 'rented' ? 'This property is rented' : 'This property is no longer available';
  return new ApiError(410, 'LISTING_UNAVAILABLE', message, {
    title: p.title, listingNo: p.listingNo, purpose: p.purpose, city: p.location && p.location.city, locality: p.location && p.location.locality,
    status, temporary: p.status === 'paused', similar: await cards(items),
  });
}

async function detail(slug) {
  const p = await Property.findOne({ status: 'live', deletedAt: null, ...(oid.test(slug) ? { _id: slug } : { slug }) }).lean();
  if (!p) throw (await unavailable(slug)) || ApiError.notFound('Property not found or no longer available');
  const s = await settings.all();
  const lister = await User.findById(p.listerId).select(serializer.LISTER_FIELDS).lean();
  return serializer.toPublicProperty(p, lister, s);
}

async function similar(id) {
  const p = await liveBySlugOrId(id);
  const price = p.purpose === 'rent' ? p.price && p.price.monthlyRent : p.price && p.price.amount;
  const field = p.purpose === 'rent' ? 'price.monthlyRent' : 'price.amount';
  const items = await Property.find({
    _id: { $ne: p._id }, status: 'live', deletedAt: null, purpose: p.purpose, type: p.type, 'location.cityId': p.location.cityId,
    ...(price ? { [field]: { $gte: Math.round(price * 0.8), $lte: Math.round(price * 1.2) } } : {}),
  }).sort({ liveAt: -1 }).limit(6).lean();
  return cards(items);
}

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|curl|wget|python-requests/i;

async function recordView(id, req) {
  const ua = String(req.headers['user-agent'] || '');
  if (BOT.test(ua)) return { counted: false };
  const p = await Property.findOne({ _id: oid.test(id) ? id : null, status: 'live' }).select('_id').lean();
  if (!p) throw ApiError.notFound('Property not found');
  const session = String(req.headers['x-session-id'] || '') || `${req.ip}|${ua}`;
  const sessionHash = crypto.createHash('sha256').update(session).digest('hex').slice(0, 32);
  const day = new Date().toISOString().slice(0, 10);
  try {
    await PropertyView.create({ propertyId: p._id, sessionHash, day });
  } catch (e) {
    if (e.code === 11000) return { counted: false };
    throw e;
  }
  await Property.updateOne({ _id: p._id }, { $inc: { 'stats.views': 1 } });
  return { counted: true };
}

async function compare(query) {
  const ids = (csv(query.ids) || []).filter((x) => oid.test(x)).slice(0, 4);
  if (!ids.length) throw ApiError.validation([{ in: 'query', path: 'ids', message: 'Pass up to 4 property ids' }]);
  const items = await Property.find({ _id: { $in: ids }, status: 'live', deletedAt: null }).lean();
  const s = await settings.all();
  const listers = await listersFor(items);
  const found = items.map((p) => serializer.toPublicProperty(p, listers[String(p.listerId)], s));
  return { items: found, dropped: ids.filter((i) => !items.some((p) => String(p._id) === i)) };
}

// ---------------------------------------------------------------- autocomplete (RE-E-15)

async function autocomplete(query) {
  const q = String(query.q || '').trim();
  if (q.length < 2) return [];
  const rx = new RegExp(esc(q), 'i');
  const city = await resolveCity(query.city);
  const { Project } = require('../projects/models');
  const [locs, cities, projects, landmarks] = await Promise.all([
    Master.find({ type: 'locality', active: true, ...(city ? { parentId: city._id } : {}), $or: [{ name: rx }, { 'meta.aliases': rx }] }).limit(6).select('name code parentId').lean(),
    Master.find({ type: 'city', active: true, name: rx }).limit(3).select('name code').lean(),
    Project.find({ status: { $in: ['live', 'sold_out'] }, name: rx }).limit(4).select('name slug location.city').lean(),
    Property.aggregate([{ $match: { status: 'live', 'location.landmarks.name': rx } }, { $unwind: '$location.landmarks' }, { $match: { 'location.landmarks.name': rx } }, { $group: { _id: '$location.landmarks.name' } }, { $limit: 4 }]),
  ]);
  const cityNames = Object.fromEntries((await Master.find({ _id: { $in: locs.map((l) => l.parentId) } }).select('name').lean()).map((c) => [String(c._id), c.name]));
  return [
    ...cities.map((c) => ({ kind: 'city', label: c.name, value: c.code })),
    ...locs.map((l) => ({ kind: 'locality', label: `${l.name}, ${cityNames[String(l.parentId)] || ''}`.replace(/, $/, ''), value: l.code, id: String(l._id) })),
    ...projects.map((p) => ({ kind: 'project', label: `${p.name}${p.location && p.location.city ? `, ${p.location.city}` : ''}`, value: p.slug })),
    ...landmarks.map((l) => ({ kind: 'landmark', label: l._id, value: l._id })),
  ];
}

// ---------------------------------------------------------------- home and landing pages (RE-E-11)

async function home() {
  const s = await settings.all();
  const { Project } = require('../projects/models');
  const projects = require('../projects/service');
  const now = new Date();
  const [featured, latest, liveProjects, cities, topLocalities] = await Promise.all([
    Property.find({ status: 'live', 'featured.on': true, $or: [{ 'featured.until': null }, { 'featured.until': { $gt: now } }] }).sort({ liveAt: -1 }).limit(8).lean(),
    Property.find({ status: 'live' }).sort({ liveAt: -1 }).limit(8).lean(),
    Project.find({ status: { $in: ['live', 'sold_out'] } }).sort({ 'featured.on': -1, liveAt: -1 }).limit(6),
    Master.find({ type: 'city', active: true }).sort({ sort: 1, name: 1 }).select('name code meta.state').lean(),
    Property.aggregate([{ $match: { status: 'live' } }, { $group: { _id: '$location.localityId', name: { $first: '$location.locality' }, city: { $first: '$location.city' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
  ]);
  const cityCounts = await Property.aggregate([{ $match: { status: 'live' } }, { $group: { _id: '$location.cityId', n: { $sum: 1 } } }]);
  const countByCity = Object.fromEntries(cityCounts.map((c) => [String(c._id), c.n]));
  return {
    sections: s['home.sections'] || ['search', 'featured', 'projects', 'localities', 'latest'],
    hotline: s['general.hotlineNumber'],
    featured: await cards(featured),
    latest: await cards(latest),
    projects: liveProjects.map((p) => projects.publicView(p)),
    cities: cities.map((c) => ({ name: c.name, code: c.code, state: c.meta && c.meta.state, listings: countByCity[String(c._id)] || 0 })),
    localities: topLocalities.filter((l) => l._id).map((l) => ({ id: String(l._id), name: l.name, city: l.city, listings: l.n })),
  };
}

async function areaStats(match) {
  const minPts = await settings.get('trends.minDataPoints');
  const rows = await Property.aggregate([
    { $match: { status: 'live', deletedAt: null, ...match } },
    { $group: { _id: '$purpose', n: { $sum: 1 }, avgPpsf: { $avg: '$price.pricePerSqft' }, avgRent: { $avg: '$price.monthlyRent' } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r]));
  const sale = by.sale || { n: 0 };
  const rent = by.rent || { n: 0 };
  return {
    sale: { listings: sale.n, avgPricePerSqft: sale.n >= minPts ? Math.round(sale.avgPpsf || 0) : null },
    rent: { listings: rent.n, avgMonthlyRent: rent.n >= minPts ? Math.round(rent.avgRent || 0) : null },
    minDataPoints: minPts,
  };
}

async function citySummary(cityKey) {
  const city = await resolveCity(cityKey);
  if (!city) throw ApiError.notFound('City not found');
  const [stats, localities, latest] = await Promise.all([
    areaStats({ 'location.cityId': city._id }),
    localitiesIndex(cityKey),
    Property.find({ status: 'live', 'location.cityId': city._id }).sort({ liveAt: -1 }).limit(8).lean(),
  ]);
  return { city: { name: city.name, code: city.code, state: city.meta && city.meta.state }, stats, localities: localities.slice(0, 12), latest: await cards(latest) };
}

async function localityOr404(cityKey, locKey) {
  const city = await resolveCity(cityKey);
  if (!city) throw ApiError.notFound('City not found');
  const loc = await Master.findOne({ type: 'locality', parentId: city._id, ...(oid.test(locKey) ? { _id: locKey } : { $or: [{ code: locKey.toLowerCase() }, { slug: locKey.toLowerCase() }] }) }).lean();
  if (!loc) throw ApiError.notFound('Locality not found');
  return { city, loc };
}

async function localitySummary(cityKey, locKey) {
  const { city, loc } = await localityOr404(cityKey, locKey);
  const [stats, latest, trend] = await Promise.all([
    areaStats({ 'location.localityId': loc._id }),
    Property.find({ status: 'live', 'location.localityId': loc._id }).sort({ liveAt: -1 }).limit(12).lean(),
    trends(cityKey, locKey),
  ]);
  return { city: { name: city.name, code: city.code }, locality: { name: loc.name, code: loc.code, id: String(loc._id) }, stats, trend, latest: await cards(latest) };
}

async function localitiesIndex(cityKey) {
  const city = await resolveCity(cityKey);
  if (!city) throw ApiError.notFound('City not found');
  const minPts = await settings.get('trends.minDataPoints');
  const [locs, rows] = await Promise.all([
    Master.find({ type: 'locality', parentId: city._id, active: true, mergedInto: null }).select('name code').sort({ name: 1 }).lean(),
    Property.aggregate([
      { $match: { status: 'live', 'location.cityId': city._id } },
      { $group: { _id: { l: '$location.localityId', p: '$purpose' }, n: { $sum: 1 }, ppsf: { $avg: '$price.pricePerSqft' }, rent: { $avg: '$price.monthlyRent' } } },
    ]),
  ]);
  return locs.map((l) => {
    const sale = rows.find((r) => String(r._id.l) === String(l._id) && r._id.p === 'sale') || { n: 0 };
    const rent = rows.find((r) => String(r._id.l) === String(l._id) && r._id.p === 'rent') || { n: 0 };
    return { id: String(l._id), name: l.name, code: l.code, saleListings: sale.n, rentListings: rent.n, avgPricePerSqft: sale.n >= minPts ? Math.round(sale.ppsf || 0) : null, avgMonthlyRent: rent.n >= minPts ? Math.round(rent.rent || 0) : null };
  }).sort((a, b) => (b.saleListings + b.rentListings) - (a.saleListings + a.rentListings));
}

// ---------------------------------------------------------------- trends (E3, RE-E-17)

const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

async function trends(cityKey, locKey) {
  const { loc } = await localityOr404(cityKey, locKey);
  const rows = await LocalityTrend.find({ localityId: loc._id, published: true }).sort({ month: 1 }).limit(48).lean();
  const series = (purpose) => rows.filter((r) => r.purpose === purpose).slice(-12).map((r) => ({ month: r.month, avgPerSqft: r.avgPerSqft, medianPerSqft: r.medianPerSqft, dataPoints: r.dataPoints }));
  const change = (purpose) => {
    const s = rows.filter((r) => r.purpose === purpose);
    if (!s.length) return null;
    const last = s[s.length - 1];
    const [y, m] = last.month.split('-').map(Number);
    const prev = s.find((r) => r.month === `${y - 1}-${String(m).padStart(2, '0')}`);
    return prev && prev.avgPerSqft ? Math.round(((last.avgPerSqft - prev.avgPerSqft) / prev.avgPerSqft) * 1000) / 10 : null;
  };
  return { sale: series('sale'), rent: series('rent'), oneYearChangePct: { sale: change('sale'), rent: change('rent') }, indicative: true };
}

// Nightly: per locality / purpose / category, price per sq ft from live listings (deals weighted x2), 3-sigma outliers removed.
async function computeTrends(now = new Date()) {
  const minPts = await settings.get('trends.minDataPoints');
  const dealWeight = await settings.get('trends.dealWeight');
  const month = monthKey(now);
  const rows = await Property.aggregate([
    { $match: { status: 'live', 'price.pricePerSqft': { $gt: 0 }, 'location.localityId': { $ne: null } } },
    { $group: { _id: { l: '$location.localityId', c: '$location.cityId', p: '$purpose', cat: '$category' }, values: { $push: '$price.pricePerSqft' } } },
  ]);
  let dealRows = [];
  try {
    const { Deal } = require('../deals/models');
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    dealRows = await Deal.aggregate([
      { $match: { status: 'verified', verifiedAt: { $gte: from }, pricePerSqft: { $gt: 0 } } },
      { $group: { _id: { l: '$localityId', p: '$purpose', cat: '$category' }, values: { $push: '$pricePerSqft' } } },
    ]);
  } catch { dealRows = []; }
  let written = 0;
  for (const r of rows) {
    const deals = (dealRows.find((d) => String(d._id.l) === String(r._id.l) && d._id.p === r._id.p && d._id.cat === r._id.cat) || { values: [] }).values;
    let pts = [...r.values, ...deals.flatMap((v) => Array(dealWeight).fill(v))];
    const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
    const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length);
    if (sd > 0) pts = pts.filter((v) => Math.abs(v - mean) <= 3 * sd);
    const sorted = [...pts].sort((a, b) => a - b);
    const avg = Math.round(pts.reduce((a, b) => a + b, 0) / pts.length);
    const median = sorted[Math.floor(sorted.length / 2)];
    await LocalityTrend.updateOne(
      { localityId: r._id.l, purpose: r._id.p, category: r._id.cat, month },
      { $set: { cityId: r._id.c, avgPerSqft: avg, medianPerSqft: median, dataPoints: r.values.length + deals.length, sources: { listings: r.values.length, deals: deals.length }, published: r.values.length + deals.length >= minPts } },
      { upsert: true },
    );
    written += 1;
  }
  return { month, written };
}

// ---------------------------------------------------------------- sentence parser (E4, RE-E-19)

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const TYPE_WORDS = { flat: 'apartment', apartment: 'apartment', apartments: 'apartment', villa: 'villa', villas: 'villa', plot: 'residential_plot', plots: 'residential_plot', land: 'residential_plot', office: 'office', shop: 'shop', house: 'independent_house', bungalow: 'independent_house' };

async function parseSentence(query) {
  const text = String(query.q || '').toLowerCase().replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { filters: {}, unparsed: [] };
  const filters = {};
  let rest = ` ${text} `;
  const take = (rx, fn) => { const m = rest.match(rx); if (m) { fn(m); rest = rest.replace(m[0], ' '); } };
  take(/\b(rent|rental|lease|for rent)\b/, () => { filters.purpose = 'rent'; });
  take(/\b(buy|purchase|sale|for sale)\b/, () => { filters.purpose = filters.purpose || 'sale'; });
  take(/\b(\d|one|two|three|four|five|six)\s*-?\s*(bhk|bedroom|bed|rk)\b/, (m) => { filters.bhk = String(NUM_WORDS[m[1]] || Number(m[1])); });
  const money = (n, unit) => {
    const v = Number(n);
    if (/cr|crore/.test(unit || '')) return Math.round(v * 1e7);
    if (/l|lakh|lac/.test(unit || '')) return Math.round(v * 1e5);
    if (/k/.test(unit || '')) return Math.round(v * 1e3);
    return Math.round(v);
  };
  take(/\b(under|below|less than|upto|up to|within|max)\s+(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lakh|lakhs|lac|k)?\b/, (m) => { filters.maxPrice = money(m[2], m[3]); });
  take(/\b(above|over|more than|min|from)\s+(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lakh|lakhs|lac|k)?\b/, (m) => { filters.minPrice = money(m[2], m[3]); });
  if (filters.maxPrice && filters.maxPrice < 300000 && !filters.purpose) filters.purpose = 'rent';
  if (!filters.purpose) filters.purpose = 'sale';
  take(/\b(fully furnished|semi furnished|semi-furnished|unfurnished|furnished)\b/, (m) => { filters.furnishing = m[1].startsWith('semi') ? 'semi' : m[1] === 'unfurnished' ? 'unfurnished' : 'full'; });
  take(/\b(ready to move|ready)\b/, () => { filters.possession = 'ready'; });
  take(/\b(under construction|new launch)\b/, () => { filters.possession = 'under_construction'; });
  for (const [w, t] of Object.entries(TYPE_WORDS)) if (new RegExp(`\\b${w}\\b`).test(rest)) { filters.types = t; rest = rest.replace(new RegExp(`\\b${w}\\b`), ' '); break; }
  take(/\bnear (metro|station|school|hospital|it park)\b/, (m) => { filters.near = m[1]; });
  const city = await resolveCity(query.city);
  const locs = await Master.find({ type: 'locality', active: true, ...(city ? { parentId: city._id } : {}) }).select('name code meta.aliases parentId').lean();
  const found = [];
  for (const l of locs) {
    const names = [l.name, ...((l.meta && l.meta.aliases) || [])].map((n) => n.toLowerCase());
    const hit = names.find((n) => rest.includes(` ${n} `));
    if (hit) { found.push(l.code); rest = rest.replace(` ${hit} `, ' '); }
  }
  if (found.length) filters.localities = found.join(',');
  const cities = await Master.find({ type: 'city', active: true }).select('name code').lean();
  const c = cities.find((x) => rest.includes(` ${x.name.toLowerCase()} `));
  if (c) { filters.city = c.code; rest = rest.replace(` ${c.name.toLowerCase()} `, ' '); } else if (city) filters.city = city.code;
  const unparsed = rest.split(' ').filter((w) => w && !['in', 'at', 'a', 'an', 'the', 'for', 'with', 'and', 'near', 'of', 'property', 'properties', 'home', 'homes'].includes(w));
  return { filters, unparsed };
}

// ---------------------------------------------------------------- shortlist (RE-E-07)

async function shortlist(user) {
  const rows = await Shortlist.find({ userId: user._id }).sort({ createdAt: -1 }).lean();
  const props = await Property.find({ _id: { $in: rows.map((r) => r.propertyId) } }).lean();
  const live = props.filter((p) => p.status === 'live');
  const c = await cards(live);
  return rows.map((r) => {
    const card = c.find((x) => x.id === String(r.propertyId));
    return card ? { ...card, savedAt: r.createdAt, priceAtSave: r.priceAtSave, available: true } : { id: String(r.propertyId), available: false, savedAt: r.createdAt };
  });
}

async function addShortlist(user, body) {
  const { propertyId } = z.object({ propertyId: z.string().regex(oid) }).parse(body);
  const p = await liveBySlugOrId(propertyId);
  if (await Shortlist.countDocuments({ userId: user._id }) >= 100) throw ApiError.validation([{ in: 'body', path: 'propertyId', message: 'Your shortlist is full (100). Remove some first.' }]);
  try {
    await Shortlist.create({ userId: user._id, propertyId: p._id, priceAtSave: p.purpose === 'rent' ? p.price.monthlyRent : p.price.amount });
    await Property.updateOne({ _id: p._id }, { $inc: { 'stats.shortlists': 1 } });
  } catch (e) { if (e.code !== 11000) throw e; }
  return { saved: true };
}

async function removeShortlist(user, propertyId) {
  const r = await Shortlist.deleteOne({ userId: user._id, propertyId });
  if (r.deletedCount) await Property.updateOne({ _id: propertyId }, { $inc: { 'stats.shortlists': -1 } });
  return { removed: r.deletedCount === 1 };
}

// Price drop (RE-E-10, >= 5%) and unavailable (paused / sold) notices to shortlisters.
async function notifyShortlisters(p, event, vars) {
  const rows = await Shortlist.find({ propertyId: p._id }).select('userId').lean();
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) }, status: 'active' });
  for (const u of users) await notifyUser({ user: u, event, channels: event === 'shortlist.price_drop' ? ['in_app', 'email'] : ['in_app'], vars: { listingNo: p.listingNo, title: p.title, slug: p.slug, ...vars } });
  return users.length;
}

async function onPriceChange(p, beforePaise, afterPaise) {
  if (!beforePaise || !afterPaise || afterPaise >= beforePaise) return 0;
  const pct = Math.round(((beforePaise - afterPaise) / beforePaise) * 100);
  return pct >= 5 ? notifyShortlisters(p, 'shortlist.price_drop', { percent: pct }) : 0;
}

// ---------------------------------------------------------------- saved searches and alerts (RE-E-08/09, E2)

const savedSchema = z.object({
  name: z.string().trim().min(2).max(60),
  filters: z.record(z.any()),
  frequency: z.enum(['instant', 'daily', 'weekly', 'off']).default('daily'),
  channels: z.array(z.enum(['email', 'in_app'])).min(1).default(['email', 'in_app']),
});

const listSaved = (user) => SavedSearch.find({ userId: user._id }).sort({ createdAt: -1 }).lean();

async function createSaved(user, body) {
  const d = savedSchema.parse(body);
  await buildFilter(d.filters); // validates the filter shape
  if (await SavedSearch.countDocuments({ userId: user._id }) >= 10) throw ApiError.validation([{ in: 'body', path: 'name', message: 'You can keep up to 10 saved searches' }]);
  return SavedSearch.create({ ...d, userId: user._id, lastAlertAt: new Date() });
}

async function editSaved(user, id, body) {
  const d = savedSchema.partial().parse(body);
  if (d.filters) await buildFilter(d.filters);
  const s = await SavedSearch.findOneAndUpdate({ _id: id, userId: user._id }, { $set: d }, { new: true });
  if (!s) throw ApiError.notFound('Saved search not found');
  return s;
}

async function deleteSaved(user, id) {
  const r = await SavedSearch.deleteOne({ _id: id, userId: user._id });
  if (!r.deletedCount) throw ApiError.notFound('Saved search not found');
  return { deleted: true };
}

const unsubSig = (id) => crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(`alerts:${id}`).digest('hex').slice(0, 32);
const unsubscribeToken = (id) => `${id}.${unsubSig(String(id))}`;

async function unsubscribe(token) {
  const [id, sig] = String(token).split('.');
  if (!oid.test(id || '') || sig !== unsubSig(id)) throw ApiError.badRequest('This link is not valid', 'TOKEN_INVALID');
  const s = await SavedSearch.findByIdAndUpdate(id, { $set: { frequency: 'off' } }, { new: true });
  if (!s) throw ApiError.notFound('Saved search not found');
  return { name: s.name, frequency: 'off' };
}

async function matches(saved, propertyIds) {
  try {
    const { filter } = await buildFilter(saved.filters);
    return Property.find({ ...filter, _id: { $in: propertyIds } }).lean();
  } catch { return []; }
}

// Instant alerts when a listing goes live (approval or renewal).
async function alertInstant(propertyId) {
  const max = await settings.get('alerts.maxInstantPerDay');
  const day = new Date().toISOString().slice(0, 10);
  const searches = await SavedSearch.find({ frequency: 'instant' });
  let sent = 0;
  for (const s of searches) {
    const [hit] = await matches(s, [propertyId]);
    if (!hit) continue;
    const count = s.alertsToday && s.alertsToday.day === day ? s.alertsToday.count : 0;
    if (count >= max) continue;
    const user = await User.findById(s.userId);
    if (!user || user.status !== 'active') continue;
    await notifyUser({ user, event: 'alert.instant', channels: s.channels, vars: { searchName: s.name, listingNo: hit.listingNo, title: hit.title, slug: hit.slug, unsubscribe: `/alerts/unsubscribe/${unsubscribeToken(s._id)}` } });
    s.alertsToday = { day, count: count + 1 };
    s.matchCountSinceVisit += 1;
    s.lastAlertAt = new Date();
    await s.save();
    sent += 1;
  }
  return sent;
}

async function alertDigest(frequency, now = new Date()) {
  const searches = await SavedSearch.find({ frequency });
  let sent = 0;
  for (const s of searches) {
    const since = s.lastAlertAt || s.createdAt;
    const { filter } = await buildFilter(s.filters).catch(() => ({ filter: null }));
    if (!filter) continue;
    const hits = await Property.find({ ...filter, liveAt: { $gt: since, $lte: now } }).sort({ liveAt: -1 }).limit(10).lean();
    s.lastAlertAt = now;
    if (hits.length) {
      const user = await User.findById(s.userId);
      if (user && user.status === 'active') {
        await notifyUser({ user, event: 'alert.digest', channels: ['email'], vars: { searchName: s.name, count: hits.length, period: frequency === 'weekly' ? 'this week' : 'today', list: hits.map((h) => `${h.title} (${h.listingNo})`).join('\n'), unsubscribe: `/alerts/unsubscribe/${unsubscribeToken(s._id)}` } });
        s.matchCountSinceVisit += hits.length;
        sent += 1;
      }
    }
    await s.save();
  }
  return sent;
}

// ---------------------------------------------------------------- reported listings (RE-E-13)

const reportSchema = z.object({
  reason: z.enum(['wrong_info', 'already_sold', 'fraud', 'broker', 'duplicate', 'other']),
  details: z.string().trim().max(1000).optional(),
  phone: z.string().trim().max(20).optional(),
});

async function reportListing(id, body, req) {
  const d = reportSchema.parse(body);
  const p = await liveBySlugOrId(id);
  const day = new Date(Date.now() - 86400000);
  const ipHash = crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 24);
  if (await ListingReport.countDocuments({ 'reporter.ipHash': ipHash, createdAt: { $gt: day } }) >= 5) throw new ApiError(429, 'RATE_LIMITED', 'Too many reports today. Please call the hotline.');
  const r = await ListingReport.create({ reportNo: await counters.reportNo(), propertyId: p._id, reporter: { userId: req.user && req.user._id, phone: d.phone, ipHash }, reason: d.reason, details: d.details });
  await notifyPermission('properties.manage', 'listing.reported', { listingNo: p.listingNo, reason: d.reason, reportId: String(r._id) });
  // 3 distinct broker reports in 30 days raise a broker flag (RE-F-06).
  if (d.reason === 'broker') {
    const since = new Date(Date.now() - 30 * 86400000);
    const n = (await ListingReport.distinct('reporter.ipHash', { propertyId: p._id, reason: 'broker', createdAt: { $gt: since } })).length;
    if (n >= 3) await require('../kyc/service').raiseFlag(p.listerId, 'reports', { source: 'buyer_reports', propertyId: p._id, reports: n });
  }
  return { reportNo: r.reportNo };
}

async function listReports(query) {
  const filter = { status: query.status ? { $in: String(query.status).split(',') } : { $in: ['open', 'under_review'] } };
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, parseInt(query.limit, 10) || 20);
  const [items, total] = await Promise.all([
    ListingReport.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).populate('propertyId', 'listingNo title status slug location.city listerId').lean(),
    ListingReport.countDocuments(filter),
  ]);
  const sla = await settings.get('reports.reviewSlaHours');
  const now = Date.now();
  items.forEach((i) => { const h = (now - new Date(i.createdAt).getTime()) / 3600000; i.sla = { hours: sla, ageHours: Math.round(h), level: h >= sla ? 'red' : h >= 0.75 * sla ? 'amber' : 'green' }; delete i.reporter; });
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// Actions: dismiss, ask_fix, pause, take_down, raise_broker_flag. `flag: true`
// raises a broker flag alongside ask_fix / pause / take_down (RE-F-06); the
// flag goes through the kyc broker-flag service with the report as evidence.
async function actionReport(id, body, req) {
  const d = z.object({ action: z.enum(['dismiss', 'ask_fix', 'pause', 'take_down', 'raise_broker_flag']), note: z.string().trim().min(3).max(500), flag: z.boolean().optional() }).parse(body);
  const r = await ListingReport.findById(id);
  if (!r) throw ApiError.notFound('Report not found');
  if (['actioned', 'dismissed'].includes(r.status)) throw ApiError.conflict('Report already decided', 'INVALID_TRANSITION');
  if (d.flag && d.action === 'dismiss') throw ApiError.badRequest('A dismissed report cannot raise a broker flag');
  const p = await Property.findById(r.propertyId);
  const lister = await User.findById(p.listerId);
  if (d.action === 'pause' && p.status === 'live') await require('../approvals/review.service').adminAction(p._id, { action: 'pause', reason: `Reported: ${d.note}` }, req);
  if (d.action === 'take_down' && ['live', 'paused'].includes(p.status)) await require('../approvals/review.service').adminAction(p._id, { action: 'deactivate', reason: `Reported: ${d.note}` }, req);
  let brokerFlag = null;
  if (d.action === 'raise_broker_flag' || d.flag) brokerFlag = await require('../kyc/service').flagFromReport(r, p, d.note, req);
  if (!['dismiss', 'raise_broker_flag'].includes(d.action)) await notifyUser({ user: lister, event: 'listing.report_actioned', channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, action: { ask_fix: 'please fix', pause: 'paused', take_down: 'taken down' }[d.action], note: d.note } });
  Object.assign(r, { status: d.action === 'dismiss' ? 'dismissed' : 'actioned', action: d.action, note: d.note, decidedBy: req.user._id, decidedAt: new Date() });
  await r.save();
  // Close the other open reports on the same listing with the same action.
  if (d.action !== 'dismiss') await ListingReport.updateMany({ propertyId: p._id, status: { $in: ['open', 'under_review'] }, _id: { $ne: r._id } }, { $set: { status: 'actioned', action: d.action, note: `With ${r.reportNo}`, decidedBy: req.user._id, decidedAt: new Date() } });
  await audit(req, { action: `listing_report.${d.action}`, entityType: 'ListingReport', entityId: r._id, reason: d.note, after: brokerFlag ? { brokerFlagNo: brokerFlag.flagNo } : undefined });
  const out = r.toObject();
  if (brokerFlag) out.brokerFlag = { _id: brokerFlag._id, flagNo: brokerFlag.flagNo, status: brokerFlag.status };
  return out;
}

module.exports = {
  buildFilter, search, facets, map, near, detail, similar, recordView, compare, autocomplete, home,
  citySummary, localitySummary, localitiesIndex, trends, computeTrends, parseSentence,
  shortlist, addShortlist, removeShortlist, notifyShortlisters, onPriceChange,
  listSaved, createSaved, editSaved, deleteSaved, unsubscribe, unsubscribeToken, alertInstant, alertDigest,
  reportListing, listReports, actionReport, liveBySlugOrId, cards,
};
