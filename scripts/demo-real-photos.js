// Swap the generated placeholder photos of the demo data for real free photos
// (Unsplash, scripts/demo-data/photo-pool.json). LOCAL dev database only.
//   cd backend && npm run demo:photos
//
// Covers: photos of listings owned by @demo.local accounts, builder project
// photos and CMS banners. Each photo gets its own pool photo (stable per
// listing + position), goes through the real upload pipeline (renditions,
// thumbnail, watermark, aHash), and replaces the old file. Rerunning skips
// photos already swapped. New `npm run seed:demo` runs use real photos directly.
const { loadSafeEnv } = require('./demo-data/safe-env');

loadSafeEnv();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const storage = require('../src/core/storage');
const { User } = require('../src/modules/auth/models');
const { Property } = require('../src/modules/listings/models');
const { Project } = require('../src/modules/projects/models');
const { Banner } = require('../src/modules/cms/models');
const media = require('./demo-data/media');
const { projectPhotoCategory } = require('./demo-data/projects');

const USES = 'demo_photo_uses';
const CACHE = path.join(__dirname, '..', 'uploads', '.demo-photo-cache');
const counts = { swapped: 0, kept: 0, failed: 0 };

// Upload the pool photo for `key` and return the new File, or null when the
// photo is already in place (or the pool photo could not be fetched).
async function swap({ key, category, label, ownerId, purpose, currentFileId, w = 1600, h = 1067 }) {
  const uses = mongoose.connection.db.collection(USES);
  const done = await uses.findOne({ _id: key });
  if (done && done.fileId && currentFileId && String(done.fileId) === String(currentFileId)) { counts.kept += 1; return null; }
  const buf = await media.photo(label || category, key, { w, h, category });
  const use = await uses.findOne({ _id: key });
  if (!use || !fs.existsSync(path.join(CACHE, `${use.photoId}.jpg`))) { counts.failed += 1; return null; } // offline: keep the old photo
  const f = await media.upload(ownerId, purpose, buf, { name: `${String(label || category).replace(/\W+/g, '-').toLowerCase()}.jpg`, mime: 'image/jpeg' });
  await uses.updateOne({ _id: key }, { $set: { fileId: f._id } });
  if (currentFileId) {
    const old = await storage.FileModel.findById(currentFileId);
    if (old && old.purpose === purpose) await storage.remove(old).catch(() => {});
  }
  counts.swapped += 1;
  return f;
}

async function listings() {
  const owners = await User.find({ email: /@demo\.local$/i }).select('_id').lean();
  const props = await Property.find({ listerId: { $in: owners.map((u) => u._id) }, 'media.photos.0': { $exists: true } });
  for (const p of props) {
    const photos = p.media.photos.map((ph) => ph.toObject());
    let changed = false;
    for (const [i, ph] of photos.entries()) {
      const category = media.categoryFor({ type: p.type, category: p.category, tag: ph.tag, label: ph.caption || '' });
      const f = await swap({ key: `prop:${p.listingNo}:${i}`, category, label: ph.caption, ownerId: p.listerId, purpose: 'property_photo', currentFileId: ph.fileId });
      if (!f) continue;
      f.attachedTo = { type: 'Property', id: p._id };
      await f.save();
      Object.assign(ph, { fileId: f._id, url: f.url, thumbUrl: f.meta && f.meta.thumbUrl, hash: f.meta && f.meta.ahash });
      changed = true;
    }
    if (changed) await Property.collection.updateOne({ _id: p._id }, { $set: { 'media.photos': photos } });
    process.stdout.write('.');
  }
  return props.length;
}

async function projects() {
  const list = await Project.find({ 'media.photos.0': { $exists: true } });
  for (const p of list) {
    const photos = p.media.photos.map((ph) => (ph.toObject ? ph.toObject() : ph));
    let changed = false;
    for (const [i, ph] of photos.entries()) {
      const f = await swap({ key: `proj:${p.projectNo}:${i}`, category: projectPhotoCategory(ph.caption || ''), label: ph.caption, ownerId: p.builderId || p.listerId, purpose: 'project_media', currentFileId: ph.fileId });
      if (!f) continue;
      f.attachedTo = { type: 'Project', id: p._id };
      await f.save();
      Object.assign(ph, { fileId: f._id, url: f.url });
      changed = true;
    }
    if (changed) await Project.collection.updateOne({ _id: p._id }, { $set: { 'media.photos': photos } });
  }
  return list.length;
}

async function banners() {
  const list = await Banner.find({ imageFileId: { $ne: null } });
  for (const [i, b] of list.entries()) {
    const old = await storage.FileModel.findById(b.imageFileId);
    const f = await swap({ key: `banner:${b._id}`, category: i % 2 ? 'apartment_ext' : 'villa', label: b.title, ownerId: old ? old.ownerId : null, purpose: (old && old.purpose) || 'banner_image', currentFileId: b.imageFileId, w: 1600, h: 500 });
    if (f) await Banner.collection.updateOne({ _id: b._id }, { $set: { imageFileId: f._id, imageUrl: f.url } });
  }
  return list.length;
}

(async () => {
  await mongoose.connect(env.MONGO_URI);
  const n1 = await listings();
  const n2 = await projects();
  const n3 = await banners();
  console.log(`\nlistings ${n1}, projects ${n2}, banners ${n3}: swapped ${counts.swapped}, already real ${counts.kept}, not fetched ${counts.failed}`);
  await mongoose.disconnect();
})().catch(async (err) => { console.error(err); await mongoose.disconnect(); process.exit(1); });
