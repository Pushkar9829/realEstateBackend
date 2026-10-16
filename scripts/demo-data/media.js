// Generated demo media: JPEG photos (sharp) with a random tile pattern (so every
// photo has its own perceptual hash and the duplicate-photo rules stay quiet)
// and a text label, small valid PDFs (pdfkit) and CSV files. Every file goes
// through the real pipeline (core/media.processImage + core/storage.save), so
// renditions, thumbnails and aHashes exist exactly as for a real upload.
const crypto = require('crypto');
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

// A 1280x960 (or w x h) JPEG: 8x8 tiles of random lightness in one hue, a label band in the middle.
async function photo(label, seed, { w = 1280, h = 960, sub = '' } = {}) {
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

module.exports = { photo, pdf, upload, uploadPhoto, uploadPdf, uploadCsv };
