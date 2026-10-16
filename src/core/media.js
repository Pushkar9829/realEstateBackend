// Image processing for uploads (RE-A-14): auto-rotate, strip all metadata
// (EXIF incl. GPS), a large rendition capped at 1600 px on the long edge
// (JPEG), a 400 px thumbnail and an average hash (aHash) for duplicate-photo
// checks (rule R3). When the `media.watermark` setting is on, public photo
// purposes get a text (or logo) watermark composited on the large rendition.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ApiError = require('./http/ApiError');

const LARGE_PX = 1600;
const THUMB_PX = 400;
// Purposes shown publicly; only these are watermarked (verification captures, avatars and banners are not).
const WATERMARKED = ['property_photo', 'project_media'];

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

// `media.watermark`: false | true (text = general.companyName) | { text, logo, opacity, position }.
// `logo` may be a data: URL (PNG / JPEG / SVG) or a key in the local storage directory.
async function watermarkConfig(purpose) {
  if (!WATERMARKED.includes(purpose)) return null;
  const settings = require('./settings');
  const w = await settings.get('media.watermark');
  if (!w) return null;
  const cfg = typeof w === 'object' ? w : {};
  return {
    text: cfg.text || await settings.get('general.companyName'),
    logo: cfg.logo,
    opacity: Math.min(1, Math.max(0.05, Number(cfg.opacity) || 0.45)),
    position: cfg.position || 'southeast',
  };
}

function logoBuffer(logo) {
  if (!logo) return null;
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(logo);
  if (m) return Buffer.from(m[1], 'base64');
  const { localDir } = require('./storage');
  const full = path.resolve(localDir, logo);
  if (!full.startsWith(path.resolve(localDir)) || !fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Composites the watermark on a JPEG buffer; the mark is sized from the image width.
async function applyWatermark(buffer, cfg) {
  const { width, height } = await sharp(buffer).metadata();
  const pad = Math.round(width * 0.02);
  let overlay;
  const logo = logoBuffer(cfg.logo);
  if (logo) {
    const lw = Math.round(width * 0.18);
    const resized = await sharp(logo).resize({ width: lw, height: Math.round(height * 0.2), fit: 'inside' }).ensureAlpha().png().toBuffer();
    // scale the alpha channel by the opacity
    const { data, info } = await sharp(resized).raw().toBuffer({ resolveWithObject: true });
    for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * cfg.opacity);
    overlay = await sharp(data, { raw: info }).png().toBuffer();
  } else {
    const size = Math.max(14, Math.round(width * 0.03));
    const text = escapeXml(cfg.text).slice(0, 80);
    const w = Math.min(width - pad * 2, Math.round(text.length * size * 0.62) + pad * 2);
    const h = Math.round(size * 1.8);
    overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
      + `<text x="50%" y="62%" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="bold" `
      + `fill="#ffffff" fill-opacity="${cfg.opacity}" stroke="#000000" stroke-opacity="${cfg.opacity / 2}" stroke-width="1">${text}</text></svg>`);
  }
  const om = await sharp(overlay).metadata();
  const gravity = ['southeast', 'southwest', 'northeast', 'northwest', 'centre', 'center'].includes(cfg.position) ? cfg.position : 'southeast';
  const placed = gravity.startsWith('centre') || gravity === 'center'
    ? { gravity: 'centre' }
    : { top: gravity.startsWith('north') ? pad : Math.max(0, height - om.height - pad), left: gravity.endsWith('west') ? pad : Math.max(0, width - om.width - pad) };
  return sharp(buffer).composite([{ input: overlay, ...placed }]).jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });
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
  const clean = await sharp(file.buffer).rotate().resize({ width: LARGE_PX, height: LARGE_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true }); // sharp drops metadata unless withMetadata()
  // aHash and thumbnail come from the clean image, so the watermark never affects duplicate-photo checks.
  const ahash = await averageHash(clean.data);
  const thumbnail = await sharp(clean.data).resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
  const wm = await watermarkConfig(purpose);
  const out = wm ? await applyWatermark(clean.data, wm) : clean;
  return {
    file: { ...file, buffer: out.data, mimetype: 'image/jpeg', size: out.data.length, originalname: (file.originalname || 'image').replace(/\.[^.]+$/, '') + '.jpg' },
    meta: { width: out.info.width, height: out.info.height, ahash, ...(wm ? { watermarked: true } : {}) },
    thumbnail,
  };
}

module.exports = { processImage, averageHash, hashDistance, applyWatermark, watermarkConfig, PROCESSED, LARGE_PX, THUMB_PX };
