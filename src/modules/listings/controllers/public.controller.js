// Module A - public token links ("still available?") and geocoding helpers.
const stubs = require('../../../core/http/stubs');
const { asyncHandler, ok, ApiError } = require('../../../core/http');
const listings = require('../service');
const geo = require('../geo.service');

module.exports = {
  // Photo verification capture pages (RE-A-20) arrive in Phase 3.
  ...stubs('A', ['submitGpsDistanceCheck', 'uploadOneLivePhoto', 'sendToQa']),

  checkSummary: asyncHandler(async (req, res) => ok(res, await listings.checkSummary(req.params.token))), // GET /api/listing-checks/:token
  answerCheck: asyncHandler(async (req, res) => ok(res, await listings.answerByToken(req.params.token, req.body, req))), // POST /api/listing-checks/:token
  addressLatLng: asyncHandler(async (req, res) => { // GET /api/geo/geocode?q=
    const q = String(req.query.q || '').trim();
    if (q.length < 3) throw ApiError.validation([{ in: 'query', path: 'q', message: 'Type at least 3 characters' }]);
    ok(res, await geo.geocode(q));
  }),
  latLngLocality: asyncHandler(async (req, res) => { // GET /api/geo/reverse?lat=&lng=
    const lat = Number(req.query.lat); const lng = Number(req.query.lng);
    if (!(lat >= 6 && lat <= 37 && lng >= 68 && lng <= 98)) throw ApiError.validation([{ in: 'query', path: 'lat', message: 'Point must be inside India' }]);
    ok(res, await geo.reverse(lat, lng));
  }),
};

// ---- Phase 3: photo verification capture page (token, no login) ----
const verification = require('../verification.service');

Object.assign(module.exports, {
  capturePage: asyncHandler(async (req, res) => ok(res, await verification.capturePage(req.params.token))),
  submitGpsDistanceCheck: asyncHandler(async (req, res) => ok(res, await verification.submitLocation(req.params.token, req.body))),
  uploadOneLivePhoto: asyncHandler(async (req, res) => ok(res, await verification.uploadPhoto(req.params.token, req.file, req.body))),
  sendToQa: asyncHandler(async (req, res) => ok(res, await verification.submit(req.params.token, req.body))),
});
