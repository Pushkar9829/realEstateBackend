// Module B - Identity & Contact Masking: public panel routes (mounted at /api).
// Generated from the API tables in docs/SPEC.md (method, path, role / permission).
const router = require('express').Router();
const c = require('../controllers/public.controller');

router.get('/properties/:slug', c.maskedDetail); // public: Masked detail
router.get('/settings/public', c.hotlinePrecisionMin); // public: Hotline, precision, min %
router.post('/properties/:id/report', c.reportAListing); // public: Report a listing
router.post('/properties/:id/whatsapp-click', c.countWhatsappClicks); // public: Count WhatsApp clicks
router.get('/rera/qr', c.reraQr); // public: QR code PNG for an official RERA URL (RE-G-08)

module.exports = router;
