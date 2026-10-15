// Module E - Search & Discovery: public panel handlers.
// Generated from docs/SPEC.md. Replace each stub with a real handler as the
// module is implemented (see core/http/stubs.js).
const stubs = require('../../../core/http/stubs');

module.exports = stubs('E', [
  'homeSections', // GET /api/home - Home sections
  'search', // GET /api/properties - Search
  'boundingBoxPinsClusters', // GET /api/properties/map - Bounding box pins / clusters
  'nearMe', // GET /api/properties/near - Near me
  'suggestions', // GET /api/properties/autocomplete - Suggestions
  'similar', // GET /api/properties/:id/similar - Similar
  'viewCounter', // POST /api/properties/:id/view - View counter
  'compare', // GET /api/compare - Compare
  'activeCities', // GET /api/locations/cities - Active cities
  'localitiesByCity', // GET /api/locations/localities - Localities by city
  'cityLandingData', // GET /api/locations/:city/summary - City landing data
  'localitiesIndexWithAverages', // GET /api/locations/:city/localities/trends - Localities index with averages
  'localityLandingData', // GET /api/locations/:city/:locality/summary - Locality landing data
  'get12MonthTrendSeries', // GET /api/locations/:city/:locality/trends - 12-month trend series
  'sentenceFiltersCould', // GET /api/search/parse - Sentence -> filters (Could)
  'requestAProperty', // POST /api/leads/requirement - Request a property
  'typesAmenitiesLandmarkTypes', // GET /api/masters/public - Types, amenities, landmark types
  'shortlist', // GET /api/me/shortlist - Shortlist
  'add', // POST /api/me/shortlist - Add
  'remove', // DELETE /api/me/shortlist/:propertyId - Remove
  'list', // GET /api/me/saved-searches - List
  'create', // POST /api/me/saved-searches - Create
  'edit', // PATCH /api/me/saved-searches/:id - Edit
  'delete', // DELETE /api/me/saved-searches/:id - Delete
  'stopAlerts', // GET /api/alerts/unsubscribe/:token - Stop alerts
]);

// ---- Phase 1: public lookups used by search, signup and the listing wizard ----
const { asyncHandler, ok, ApiError } = require('../../../core/http');
const { Master } = require('../../cms/models');

Object.assign(module.exports, {
  // GET /api/locations/cities
  activeCities: asyncHandler(async (req, res) => {
    ok(res, await Master.find({ type: 'city', active: true }).sort({ sort: 1, name: 1 }).select('code name slug meta.state meta.centroid').lean());
  }),
  // GET /api/locations/localities?city=<code|id>&q=
  localitiesByCity: asyncHandler(async (req, res) => {
    const key = String(req.query.city || '');
    if (!key) throw ApiError.validation([{ in: 'query', path: 'city', message: 'city is required' }]);
    const city = await Master.findOne({ type: 'city', active: true, ...(/^[a-f0-9]{24}$/.test(key) ? { _id: key } : { code: key.toLowerCase() }) });
    if (!city) throw ApiError.notFound('City not found');
    const filter = { type: 'locality', parentId: city._id, active: true, mergedInto: null };
    if (req.query.q) {
      const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { 'meta.aliases': rx }];
    }
    ok(res, await Master.find(filter).sort({ name: 1 }).limit(200).select('code name slug meta.pincodes meta.aliases meta.centroid').lean());
  }),
  // GET /api/masters/public - property types (with category and field profile), amenities, landmark types
  typesAmenitiesLandmarkTypes: asyncHandler(async (req, res) => {
    const rows = await Master.find({ type: { $in: ['property_type', 'amenity', 'landmark_type'] }, active: true }).sort({ sort: 1 }).select('type code name meta').lean();
    ok(res, {
      propertyTypes: rows.filter((r) => r.type === 'property_type'),
      amenities: rows.filter((r) => r.type === 'amenity'),
      landmarkTypes: rows.filter((r) => r.type === 'landmark_type'),
    });
  }),
});

// ---- Phase 3: search, discovery, shortlist, saved searches (spec 4.5) ----
const search = require('../service');

const run = (fn) => asyncHandler(async (req, res) => ok(res, await fn(req)));
const page = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req); ok(res, items, meta); });

Object.assign(module.exports, {
  homeSections: run(() => search.home()),
  search: page((req) => search.search(req.query)),
  boundingBoxPinsClusters: run((req) => search.map(req.query)),
  nearMe: run((req) => search.near(req.query)),
  suggestions: run((req) => search.autocomplete(req.query)),
  similar: run((req) => search.similar(req.params.id)),
  viewCounter: run((req) => search.recordView(req.params.id, req)),
  compare: run((req) => search.compare(req.query)),
  cityLandingData: run((req) => search.citySummary(req.params.city)),
  localitiesIndexWithAverages: run((req) => search.localitiesIndex(req.params.city)),
  localityLandingData: run((req) => search.localitySummary(req.params.city, req.params.locality)),
  get12MonthTrendSeries: run((req) => search.trends(req.params.city, req.params.locality)),
  sentenceFiltersCould: run((req) => search.parseSentence(req.query)),
  requestAProperty: run((req) => require('../../leads/capture.service').requirement(req.body, req)),
  shortlist: run((req) => search.shortlist(req.user)),
  add: run((req) => search.addShortlist(req.user, req.body)),
  remove: run((req) => search.removeShortlist(req.user, req.params.propertyId)),
  list: run((req) => search.listSaved(req.user)),
  create: asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await search.createSaved(req.user, req.body) })),
  edit: run((req) => search.editSaved(req.user, req.params.id, req.body)),
  delete: run((req) => search.deleteSaved(req.user, req.params.id)),
  stopAlerts: run((req) => search.unsubscribe(req.params.token)),
});
