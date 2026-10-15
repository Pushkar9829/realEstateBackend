// Module G - Builder Projects: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/projects', c.projectSearch); // public: Project search
router.get('/projects/:slug', c.projectDetailMasked); // public: Project detail (masked)

module.exports = router;
