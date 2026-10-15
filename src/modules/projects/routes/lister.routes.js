// Module G - Builder Projects: lister panel routes (mounted at /api/lister).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/lister.controller');
const g = require('../../../core/middleware/guards');

router.get('/projects', ...g.builder, c.ownProjects); // lister (builder): Own projects
router.post('/projects', ...g.builder, c.create); // lister (builder): Create
router.get('/projects/:id', ...g.builder, c.detail); // lister (builder): Detail
router.patch('/projects/:id/steps/:tab', ...g.builder, c.saveTab); // lister (builder): Save tab
router.post('/projects/:id/media', ...g.builder, c.upload); // lister (builder): Upload
router.post('/projects/:id/commission', ...g.builder, c.acceptAgreement); // lister (builder): Accept agreement
router.post('/projects/:id/submit', ...g.builder, c.submit); // lister (builder): Submit
router.patch('/projects/:id/inventory', ...g.builder, c.updateUnits); // lister (builder): Update units
router.get('/projects/:id/units/template', ...g.builder, c.csvTemplate); // lister (builder): CSV template
router.post('/projects/:id/units/import', ...g.builder, c.uploadCsvGetPreview); // lister (builder): Upload CSV, get preview
router.post('/projects/:id/units/import/:importId/confirm', ...g.builder, c.savePreviewedRows); // lister (builder): Save previewed rows
router.get('/projects/:id/units', ...g.builder, c.unitInventoryList); // lister (builder): Unit inventory list

module.exports = router;
