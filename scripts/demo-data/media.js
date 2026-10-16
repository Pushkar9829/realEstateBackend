// Demo media. Photos with a `category` are real free Unsplash photos from
// photo-pool.json (downloaded once into uploads/.demo-photo-cache, each photo
// used by one seed key only, so listings never share a photo); without a
// category, or when the download fails, a generated JPEG with a random tile
// pattern and a text label is used. Also small valid PDFs (pdfkit) and CSV files. Every file goes
// through the real pipeline (core/media.processImage + core/storage.save), so
// renditions, thumbnails and aHashes exist exactly as for a real upload.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const mongoose = require('mongoose');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const storage = require('../../src/core/storage');
const { processImage } = require('../../src/core/media');

// Deterministic PRNG from a string seed.
function rng(seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}

const PALETTES = [[34, 94, 168], [196, 98, 45], [46, 139, 87], [128, 70, 160], [180, 60, 80], [60, 120, 140], [150, 120, 40], [90, 90, 110]];
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- real photos
const POOL = require('./photo-pool.json').pool;
const CACHE = path.join(__dirname, '..', '..', 'uploads', '.demo-photo-cache');
const USES = 'demo_photo_uses'; // { _id: seed key, photoId, category, mirror } in the local dev DB

function download(id) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://images.unsplash.com/${id}?w=1600&q=80&fm=jpg`, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${id}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`timeout for ${id}`)));
  });
}

async function cached(id) {
  const file = path.join(CACHE, `${id}.jpg`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const buf = await download(id);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

// The pool photo for a seed key: the same key always gets the same photo; a new
// key takes the first photo of the category nobody uses yet (mirrored reuse once
// the category runs out, so perceptual hashes still differ).
async function poolPhoto(category, seed, { w, h }) {
  const ids = POOL[category];
  if (!ids || !ids.length) throw new Error(`No pool photos for ${category}`);
  const col = mongoose.connection.db.collection(USES);
  let use = await col.findOne({ _id: String(seed) });
  if (!use || !ids.includes(use.photoId)) {
    const taken = new Set((await col.find({ category }).project({ photoId: 1 }).toArray()).map((r) => r.photoId));
    const free = ids.find((id) => !taken.has(id));
    const n = await col.countDocuments({ category });
    use = { _id: String(seed), category, photoId: free || ids[n % ids.length], mirror: !free };
    await col.replaceOne({ _id: use._id }, use, { upsert: true });
  }
  let img = sharp(await cached(use.photoId)).rotate();
  if (use.mirror) img = img.flop();
  return img.resize(w, h, { fit: 'cover', position: 'attention' }).jpeg({ quality: 84 }).toBuffer();
}

// Pool category for a listing photo: by property type first, then by room tag / label.
function categoryFor({ type, category, tag, label = '' }) {
  if (category === 'land' || /plot|land/.test(type || '')) return 'land';
  if (type === 'office' || type === 'coworking') return 'office';
  if (type === 'shop' || type === 'showroom') return tag === 'exterior' || /front|street/i.test(label) ? 'shop_front' : 'shop_inside';
  const t = tag || '';
  if (['living', 'kitchen', 'bedroom', 'balcony', 'bathroom', 'garden'].includes(t)) return t;
  const outside = () => (type === 'villa' ? 'villa' : ['independent_house', 'row_house'].includes(type) ? 'house_ext' : 'apartment_ext');
  if (t === 'exterior' || /exterior|elevation|front|door|gate/i.test(label)) return outside();
  if (/kitchen|pantry/i.test(label)) return 'kitchen';
  if (/bed/i.test(label)) return 'bedroom';
  if (/bath|toilet/i.test(label)) return 'bathroom';
  if (/balcony|window|view/i.test(label)) return 'balcony';
  if (/garden|park|lawn/i.test(label)) return 'garden';
  if (/pool|gym|club|lobby|sports|deck/i.test(label)) return 'amenity';
  return 'living';
}

// A 1280x960 (or w x h) JPEG: 8x8 tiles of random lightness in one hue, a label band in the middle.
// With `category`, a real pool photo (falls back to the generated one when offline).
async function photo(label, seed, { w = 1280, h = 960, sub = '', category } = {}) {
  if (category) {
    try { return await poolPhoto(category, seed, { w, h }); } catch { /* offline: generated photo below */ }
  }
  const r = rng(seed);
  const [cr, cg, cb] = PALETTES[Math.floor(r() * PALETTES.length)];
  const tw = w / 8; const th = h / 8;
  let tiles = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const k = 0.35 + r() * 0.9;
      const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
      tiles += `<rect x="${x * tw}" y="${y * th}" width="${tw + 1}" height="${th + 1}" fill="rgb(${c(cr)},${c(cg)},${c(cb)})"/>`;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${tiles}
    <rect x="${w * 0.12}" y="${h * 0.38}" width="${w * 0.76}" height="${h * 0.24}" rx="18" fill="rgba(0,0,0,0.55)"/>
    <text x="50%" y="${h * 0.5}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(w / 18)}" font-weight="bold" fill="#ffffff">${esc(label)}</text>
    <text x="50%" y="${h * 0.575}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(w / 40)}" fill="#e8e8e8">${esc(sub)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

// A small but valid PDF with a few lines of text (unique per seed, so receipt hashes differ).
function pdf(title, lines = [], seed = '') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Producer: 'demo-seed' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(18).text(title);
    doc.moveDown().fontSize(11);
    lines.forEach((l) => doc.text(l));
    doc.moveDown().fontSize(8).fillColor('#777').text(`Demo document generated for local testing. Ref ${crypto.createHash('sha1').update(`${title}|${seed}`).digest('hex').slice(0, 12)}`);
    doc.end();
  });
}

// Push a buffer through the upload pipeline exactly like POST /api/uploads.
async function upload(ownerId, purpose, buffer, { name = 'file', mime }) {
  const file = { buffer, originalname: name, mimetype: mime, size: buffer.length };
  const processed = await processImage(file, purpose);
  return storage.save(processed.file, { ownerId, purpose, meta: processed.meta, thumbnail: processed.thumbnail });
}

const uploadPhoto = async (ownerId, purpose, label, seed, opts = {}) => upload(ownerId, purpose, await photo(label, seed, opts), { name: `${label.replace(/\W+/g, '-').toLowerCase()}.jpg`, mime: 'image/jpeg' });
const uploadPdf = async (ownerId, purpose, title, lines, seed) => upload(ownerId, purpose, await pdf(title, lines, seed), { name: `${title.replace(/\W+/g, '-').toLowerCase()}.pdf`, mime: 'application/pdf' });
const uploadCsv = (ownerId, text, name = 'units.csv') => upload(ownerId, 'unit_csv', Buffer.from(text, 'utf8'), { name, mime: 'text/csv' });

module.exports = { photo, pdf, upload, uploadPhoto, uploadPdf, uploadCsv, categoryFor, POOL };
