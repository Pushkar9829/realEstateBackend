// Module L - CMS & Masters: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.post('/masters/localities/import', ...g.can('masters.manage'), c.csvImport); // admin (masters.manage): CSV import
router.post('/masters/localities/:id/merge', ...g.can('masters.manage'), c.merge); // admin (masters.manage): Merge
router.post('/masters/locality-requests/:id/decision', ...g.can('masters.manage'), c.decideRequest); // admin (masters.manage): Decide request
router.get('/masters/:type', ...g.staffOnly, c.listMaster); // admin: List master
router.post('/masters/:type', ...g.can('masters.manage'), c.createItem); // admin (masters.manage): Create item
router.patch('/masters/:type/reorder', ...g.can('masters.manage'), c.sort); // admin (masters.manage): Sort
router.patch('/masters/:type/:id', ...g.can('masters.manage'), c.editDeactivate); // admin (masters.manage): Edit / deactivate
router.get('/pages', ...g.can('cms.manage'), c.pages); // admin (cms.manage): Pages
router.get('/pages/:id', ...g.can('cms.manage'), c.pagesDetail); // admin (cms.manage): Pages detail
router.post('/pages', ...g.can('cms.manage'), c.pagesPost); // admin (cms.manage): Pages
router.patch('/pages/:id', ...g.can('cms.manage'), c.pagesPatch); // admin (cms.manage): Pages
router.get('/banners', ...g.can('cms.manage'), c.banners); // admin (cms.manage): Banners
router.get('/banners/:id', ...g.can('cms.manage'), c.bannersDetail); // admin (cms.manage): Banners detail
router.post('/banners', ...g.can('cms.manage'), c.bannersPost); // admin (cms.manage): Banners
router.patch('/banners/:id', ...g.can('cms.manage'), c.bannersPatch); // admin (cms.manage): Banners
router.get('/faqs', ...g.can('cms.manage'), c.faqs); // admin (cms.manage): FAQs
router.get('/faqs/:id', ...g.can('cms.manage'), c.faqsDetail); // admin (cms.manage): FAQs detail
router.post('/faqs', ...g.can('cms.manage'), c.faqsPost); // admin (cms.manage): FAQs
router.patch('/faqs/:id', ...g.can('cms.manage'), c.faqsPatch); // admin (cms.manage): FAQs
router.get('/testimonials', ...g.can('cms.manage'), c.testimonials); // admin (cms.manage): Testimonials
router.get('/testimonials/:id', ...g.can('cms.manage'), c.testimonialsDetail); // admin (cms.manage): Testimonials detail
router.post('/testimonials', ...g.can('cms.manage'), c.testimonialsPost); // admin (cms.manage): Testimonials
router.patch('/testimonials/:id', ...g.can('cms.manage'), c.testimonialsPatch); // admin (cms.manage): Testimonials
router.patch('/home-sections', ...g.can('cms.manage'), c.homeLayout); // admin (cms.manage): Home layout
router.get('/agreement-templates', ...g.can('cms.manage'), c.templates); // admin (cms.manage): Templates
router.post('/agreement-templates', ...g.can('cms.manage'), c.templatesPost); // admin (cms.manage): Templates
router.post('/agreement-templates/:id/publish', ...g.can('cms.manage'), c.publishVersion); // admin (cms.manage): Publish version

module.exports = router;
