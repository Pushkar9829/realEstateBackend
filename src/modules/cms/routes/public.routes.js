// Module L - CMS & Masters: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/pages/:slug', c.page); // public: Page
router.get('/sitemap.xml', c.sitemap); // public: Sitemap

module.exports = router;
