// File storage behind one interface (adapter pattern):
//   STORAGE_PROVIDER=local       -> ./uploads (development only; Render disk is ephemeral)
//   STORAGE_PROVIDER=cloudinary  -> Cloudinary (production)
// Public media (property photos, floor plans, banners) get public URLs. Private
// files (KYC, ownership proof, receipts, agreements) are stored privately and served through
// authorised API routes with short-lived signed URLs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const env = require('../../config/env');

const fileSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    purpose: { type: String, required: true }, // see core/middleware/upload.js PURPOSES
    provider: { type: String, enum: ['local', 'cloudinary'], required: true },
    key: { type: String, required: true }, // local path or cloudinary public_id
    url: String, // public URL (public files only)
    visibility: { type: String, enum: ['public', 'private'], default: 'public' },
    mime: String,
    sizeBytes: Number,
    resourceType: { type: String, enum: ['image', 'video', 'raw'] },
    attachedTo: { type: { type: String }, id: mongoose.Schema.Types.ObjectId }, // set when used; unattached files are purged after 24 h
    sha256: { type: String, index: true }, // exact duplicate detection (KYC docs, receipts)
    meta: { width: Number, height: Number, ahash: String, thumbKey: String, thumbUrl: String },
  },
  { timestamps: true },
);
fileSchema.index({ 'attachedTo.id': 1 });
const FileModel = mongoose.model('File', fileSchema);

const PRIVATE_PURPOSES = new Set(['data_export', 'ownership_proof', 'kyc_doc', 'verification_photo', 'receipt', 'agreement_doc', 'signed_agreement', 'payment_proof', 'unit_csv']);
const resourceTypeOf = (mime) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'raw');

const localProvider = {
  dir: path.resolve(process.cwd(), 'uploads'),
  async put(buffer, { key }) {
    const full = path.join(this.dir, key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, buffer);
    return { key, url: `${env.API_PUBLIC_URL}/uploads/${key}` };
  },
  signedUrl(doc) { return `${env.API_PUBLIC_URL}/uploads/${doc.key}`; },
  async remove(doc) { await fs.promises.rm(path.join(this.dir, doc.key), { force: true }); },
};

const cloudinaryProvider = {
  client() {
    const { v2 } = require('cloudinary');
    v2.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
    return v2;
  },
  put(buffer, { key, resourceType, visibility }) {
    const c = this.client();
    return new Promise((resolve, reject) => {
      c.uploader.upload_stream(
        { public_id: key.replace(/\.[^.]+$/, ''), resource_type: resourceType, type: visibility === 'private' ? 'authenticated' : 'upload' },
        (err, r) => (err ? reject(err) : resolve({ key: r.public_id, url: visibility === 'private' ? undefined : r.secure_url })),
      ).end(buffer);
    });
  },
  signedUrl(doc, ttlSec = 600) {
    return this.client().url(doc.key, {
      resource_type: doc.resourceType, type: 'authenticated', sign_url: true, secure: true,
      expires_at: Math.floor(Date.now() / 1000) + ttlSec,
    });
  },
  async remove(doc) {
    await this.client().uploader.destroy(doc.key, { resource_type: doc.resourceType, type: doc.visibility === 'private' ? 'authenticated' : 'upload' });
  },
};

const provider = () => (env.STORAGE_PROVIDER === 'cloudinary' ? cloudinaryProvider : localProvider);

// Save an uploaded multer file and record it. Returns the File document.
async function save(file, { ownerId, purpose, meta, thumbnail }) {
  const visibility = PRIVATE_PURPOSES.has(purpose) ? 'private' : 'public';
  const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
  const key = `${purpose}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${ext}`;
  const resourceType = resourceTypeOf(file.mimetype);
  const stored = await provider().put(file.buffer, { key, resourceType, visibility });
  const fileMeta = { ...(meta || {}) };
  if (thumbnail) {
    const thumb = await provider().put(thumbnail, { key: key.replace(/(\.[^.]+)?$/, '_thumb.jpg'), resourceType: 'image', visibility });
    fileMeta.thumbKey = thumb.key;
    fileMeta.thumbUrl = thumb.url;
  }
  return FileModel.create({
    ownerId, purpose, visibility, resourceType, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), meta: fileMeta,
    provider: env.STORAGE_PROVIDER, key: stored.key, url: stored.url, mime: file.mimetype, sizeBytes: file.buffer.length,
  });
}

// URL a client can open: public URL, or a short-lived signed URL for private files.
const urlFor = (doc, ttlSec) => (doc.visibility === 'public' ? doc.url : provider().signedUrl(doc, ttlSec));

async function remove(doc) {
  await provider().remove(doc);
  await FileModel.deleteOne({ _id: doc._id });
}

module.exports = { save, urlFor, remove, FileModel, PRIVATE_PURPOSES, localDir: localProvider.dir };
