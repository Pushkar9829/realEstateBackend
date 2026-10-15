// Module D - Admin Approval & Operations: agent panel routes (mounted at /api/agent).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/agent.controller');
const g = require('../../../core/middleware/guards');

router.post('/verification-visits/:id/outcome', ...g.can('verification.field'), c.checklistPhotosResult); // agent (verification.field, assigned): Checklist, photos, result
router.get('/verification-visits', ...g.can('verification.field'), c.ownVerificationVisits); // agent (verification.field): Own verification visits

module.exports = router;
