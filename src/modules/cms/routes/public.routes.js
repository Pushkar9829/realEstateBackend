// Module L - CMS & Masters: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/pages/:slug', c.page); // public: Page
router.get('/sitemap.xml', c.sitemap); // public: Sitemap (or sitemap index above 50,000 URLs)
router.get('/sitemap-:part.xml', c.sitemapPart); // public: Sitemap part (RE-L-09)
router.get('/robots.txt', c.robots); // public: robots.txt (RE-L-09)

module.exports = router;
