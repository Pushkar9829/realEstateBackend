// Shared upload endpoint for every panel (Common Architecture 7C).
//   POST /api/uploads  multipart: file + purpose  ->  { id, url, purpose, mime, sizeBytes }
// Feature endpoints then reference the returned file id (KYC docs, packing
// video, POD media, return evidence, product images ...).
const router = require('express').Router();
const { z } = require('zod');
const { asyncHandler, created, ApiError } = require('../../core/http');
const { authenticate } = require('../../core/middleware/auth');
const upload = require('../../core/middleware/upload');
const storage = require('../../core/storage');
const settings = require('../../core/settings');
const { processImage } = require('../../core/media');

// Which roles may upload for which purpose.
const ALLOWED = {
  buyer: ['avatar'],
  lister: ['avatar', 'property_photo', 'property_video', 'floor_plan', 'brochure', 'ownership_proof', 'kyc_doc', 'rera_certificate', 'project_media', 'payment_proof', 'unit_csv'],
  agent: ['avatar', 'receipt', 'agreement_doc', 'verification_photo'],
  manager: ['avatar', 'receipt', 'agreement_doc'],
  admin: ['avatar', 'banner_image', 'signed_agreement', 'property_photo'],
  superadmin: ['avatar', 'banner_image', 'signed_agreement', 'property_photo'],
};

const purposeSchema = z.object({ purpose: z.enum(Object.keys(upload.PURPOSES)) });

// Pick the multer limits for the requested purpose (sent as a query param so
// it is known before the multipart body is parsed).
async function parseFile(req, res, next) {
  try {
    const { purpose } = purposeSchema.parse(req.query);
    if (!ALLOWED[req.user.role]?.includes(purpose)) throw ApiError.forbidden(`Upload purpose "${purpose}" not allowed for your account`);
    const kind = upload.PURPOSES[purpose];
    const s = await settings.all();
    const maxMB = {
      image: s['uploads.imageMaxMB'] || 5,
      document: s['uploads.docMaxMB'] || 10,
      csv: 5,
      video: s['uploads.videoMaxMB'] || 100,
    }[kind];
    req.uploadPurpose = purpose;
    upload.single('file', kind, maxMB)(req, res, next);
  } catch (e) {
    next(e instanceof z.ZodError ? ApiError.validation(e.issues.map((i) => ({ in: 'query', path: i.path.join('.'), message: i.message }))) : e);
  }
}

router.post('/uploads', authenticate, parseFile, asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach a file in the "file" field', 'FILE_REQUIRED');
  const processed = await processImage(req.file, req.uploadPurpose); // EXIF strip, resize, thumbnail, aHash
  const doc = await storage.save(processed.file, { ownerId: req.user._id, purpose: req.uploadPurpose, meta: processed.meta, thumbnail: processed.thumbnail });
  created(res, {
    id: doc._id, url: storage.urlFor(doc), thumbUrl: doc.meta && doc.meta.thumbUrl, purpose: doc.purpose, mime: doc.mime,
    sizeBytes: doc.sizeBytes, visibility: doc.visibility, width: doc.meta && doc.meta.width, height: doc.meta && doc.meta.height,
  });
}));

module.exports = {
  key: 'uploads',
  letter: '-',
  name: 'Shared uploads',
  models: { File: storage.FileModel },
  routes: { public: router },
  register() {
    // schedule: purge files never attached within 24 h
  },
};
