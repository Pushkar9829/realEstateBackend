// Module A - Property Listing & Catalog Management: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');
const upload = require('../../../core/middleware/upload');
const g = require('../../../core/middleware/guards');

router.get('/listing-checks/:token', c.checkSummary); // public (token): Check summary
router.post('/listing-checks/:token', c.answerCheck); // public (token): Answer check
router.get('/verify-photos/:token', c.capturePage); // public (token): Capture page data (no exact pin)
router.post('/verify-photos/:token/location', c.submitGpsDistanceCheck); // public (token): Submit GPS, distance check
router.post('/verify-photos/:token/photos', upload.single('file', 'image', 8), c.uploadOneLivePhoto); // public (token): Upload one live photo
router.post('/verify-photos/:token/submit', c.sendToQa); // public (token): Send to QA
router.get('/geo/geocode', ...g.listerOrStaff, c.addressLatLng); // lister, agent: Address -> lat/lng
router.get('/geo/reverse', ...g.listerOrStaff, c.latLngLocality); // lister, agent: lat/lng -> locality

module.exports = router;
