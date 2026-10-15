// Module E - Search & Discovery: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');
const g = require('../../../core/middleware/guards');

router.get('/home', c.homeSections); // public: Home sections
router.get('/properties', c.search); // public: Search
router.get('/properties/map', c.boundingBoxPinsClusters); // public: Bounding box pins / clusters
router.get('/properties/near', c.nearMe); // public: Near me
router.get('/properties/autocomplete', c.suggestions); // public: Suggestions
router.get('/properties/:id/similar', c.similar); // public: Similar
router.post('/properties/:id/view', c.viewCounter); // public: View counter
router.get('/compare', c.compare); // public: Compare
router.get('/locations/cities', c.activeCities); // public: Active cities
router.get('/locations/localities', c.localitiesByCity); // public: Localities by city
router.get('/locations/:city/summary', c.cityLandingData); // public: City landing data
router.get('/locations/:city/localities/trends', c.localitiesIndexWithAverages); // public: Localities index with averages
router.get('/locations/:city/:locality/summary', c.localityLandingData); // public: Locality landing data
router.get('/locations/:city/:locality/trends', c.get12MonthTrendSeries); // public: 12-month trend series
router.get('/search/parse', c.sentenceFiltersCould); // public: Sentence -> filters (Could)
router.post('/leads/requirement', ...g.optional, c.requestAProperty); // public, buyer: Request a property
router.get('/masters/public', c.typesAmenitiesLandmarkTypes); // public: Types, amenities, landmark types
router.get('/me/shortlist', ...g.buyerOrLister, c.shortlist); // buyer, lister: Shortlist
router.post('/me/shortlist', ...g.buyerOrLister, c.add); // buyer, lister: Add
router.delete('/me/shortlist/:propertyId', ...g.buyerOrLister, c.remove); // buyer, lister: Remove
router.get('/me/saved-searches', ...g.buyerOrLister, c.list); // buyer, lister: List
router.post('/me/saved-searches', ...g.buyerOrLister, c.create); // buyer, lister: Create
router.patch('/me/saved-searches/:id', ...g.buyerOrLister, c.edit); // buyer, lister: Edit
router.delete('/me/saved-searches/:id', ...g.buyerOrLister, c.delete); // buyer, lister: Delete
router.get('/alerts/unsubscribe/:token', c.stopAlerts); // public: Stop alerts

module.exports = router;
