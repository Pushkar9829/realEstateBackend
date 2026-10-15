// Module N - MLM Referral Capture & Outbox: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');
const g = require('../../../core/middleware/guards');

router.get('/me/referral', ...g.anyUser, c.ownCodeAndShareLink); // any logged in: Own code and share link

module.exports = router;
