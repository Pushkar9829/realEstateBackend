// Module M - Authentication & Account Security: admin panel routes (mounted at /api/admin).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/admin.controller');
const g = require('../../../core/middleware/guards');

router.get('/users/:id/consents', ...g.can('users.manage'), c.consentsOfAUser); // admin (users.manage): Consents of a user
router.get('/deletion-requests', ...g.can('users.manage'), c.deletionQueue); // admin (users.manage): Deletion queue

// Screen actions from RE-S-ADM-24/25/29 (not in the generated API tables).
router.get('/users', ...g.can('users.manage'), c.users); // admin (users.manage): Buyer accounts
router.get('/users/:id', ...g.can('users.manage'), c.user); // admin (users.manage): Account detail
router.patch('/users/:id/status', ...g.can('users.manage'), c.userStatus); // admin (users.manage): Block / unblock
router.post('/users/:id/anonymise', ...g.can('users.manage'), c.anonymise); // admin (users.manage): Anonymise (data rights)
router.patch('/deletion-requests/:id', ...g.can('users.manage'), c.decideDeletion); // admin (users.manage): Process deletion request
router.get('/settings', ...g.can('settings.manage', 'integrations.manage', 'partners.manage'), c.settings); // admin: Settings with editability
router.patch('/settings', ...g.can('settings.manage', 'integrations.manage', 'partners.manage'), c.patchSettings); // admin: Partial update, audited

module.exports = router;
