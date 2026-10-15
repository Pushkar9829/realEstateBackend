// Module K - Notifications: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');
const g = require('../../../core/middleware/guards');

router.get('/me/notifications', ...g.anyUser, c.list); // any logged in: List
router.post('/me/notifications/read-all', ...g.anyUser, c.markAllRead); // any logged in: Mark all read
router.get('/me/notifications/unread-count', ...g.anyUser, c.badge); // any logged in: Badge
router.patch('/me/notifications/:id/read', ...g.anyUser, c.markRead); // any logged in: Mark read
router.get('/me/notification-preferences', ...g.anyUser, c.preferences); // any logged in: Preferences
router.patch('/me/notification-preferences', ...g.anyUser, c.update); // any logged in: Update

module.exports = router;
