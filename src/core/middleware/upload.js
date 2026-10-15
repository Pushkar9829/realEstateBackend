// Multipart upload parsing (multer, memory storage). The storage service then
// pushes the buffer to Cloudinary or local disk. Limits come per purpose.
const multer = require('multer');
const ApiError = require('../http/ApiError');

const KINDS = {
  image: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxMB: 5 },
  document: { mimes: ['image/jpeg', 'image/png', 'application/pdf'], maxMB: 10 },
  video: { mimes: ['video/mp4', 'video/webm', 'video/quicktime'], maxMB: 100 },
  csv: { mimes: ['text/csv', 'application/vnd.ms-excel', 'text/plain'], maxMB: 5 },
};

// Upload purposes and the file kind each accepts.
const PURPOSES = {
  avatar: 'image',
  property_photo: 'image',
  property_video: 'video',
  floor_plan: 'document',
  brochure: 'document',
  ownership_proof: 'document',
  kyc_doc: 'document',
  rera_certificate: 'document',
  project_media: 'image',
  verification_photo: 'image',
  receipt: 'document',
  agreement_doc: 'document',
  signed_agreement: 'document',
  payment_proof: 'document',
  banner_image: 'image',
  unit_csv: 'csv',
};

function single(field, kind, maxMB) {
  const spec = KINDS[kind];
  const mw = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: (maxMB || spec.maxMB) * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (spec.mimes.includes(file.mimetype)
      ? cb(null, true)
      : cb(ApiError.badRequest(`Unsupported file type ${file.mimetype}`, 'UNSUPPORTED_FILE'))),
  }).single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest(`File exceeds ${maxMB || spec.maxMB} MB`, 'FILE_TOO_LARGE'));
    return next(err);
  });
}

module.exports = { single, KINDS, PURPOSES };
