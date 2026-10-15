// Image processing for uploads (RE-A-14): auto-rotate, strip all metadata
// (EXIF incl. GPS), cap the long edge at 2000 px, JPEG output, a 400 px
// thumbnail and an average hash (aHash) for duplicate-photo checks (rule R3).
const sharp = require('sharp');
const ApiError = require('./http/ApiError');

// Purposes whose images are processed, and their minimum size (long x short edge).
const PROCESSED = {
  property_photo: { min: [1024, 768] },
  project_media: { min: [1024, 768] },
  verification_photo: { min: [640, 480] },
  banner_image: { min: [800, 300] },
  avatar: { min: [64, 64] },
};

async function averageHash(buffer) {
  const px = await sharp(buffer).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
  const avg = px.reduce((a, b) => a + b, 0) / px.length;
  let bits = '';
  for (const p of px) bits += p >= avg ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

// Hamming distance between two aHashes (0 = identical, <= 5 = near-duplicate).
function hashDistance(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

async function processImage(file, purpose) {
  const rule = PROCESSED[purpose];
  if (!rule || !file.mimetype.startsWith('image/')) return { file };
  let meta;
  try {
    meta = await sharp(file.buffer).rotate().metadata();
  } catch {
    throw ApiError.badRequest('The image could not be read', 'BAD_IMAGE');
  }
  // EXIF orientation 5-8 swaps width and height
  const [w, h] = meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  const [minLong, minShort] = rule.min;
  if (Math.max(w, h) < minLong || Math.min(w, h) < minShort) {
    throw ApiError.badRequest(`Image must be at least ${minLong} x ${minShort} pixels (got ${w} x ${h})`, 'IMAGE_TOO_SMALL');
  }
  const out = await sharp(file.buffer).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true }); // sharp drops metadata unless withMetadata()
  const thumbnail = await sharp(out.data).resize({ width: 400, height: 400, fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
  return {
    file: { ...file, buffer: out.data, mimetype: 'image/jpeg', size: out.data.length, originalname: (file.originalname || 'image').replace(/\.[^.]+$/, '') + '.jpg' },
    meta: { width: out.info.width, height: out.info.height, ahash: await averageHash(out.data) },
    thumbnail,
  };
}

module.exports = { processImage, averageHash, hashDistance, PROCESSED };
