// Shared Phase 2 fixtures: masters, templates, verified listers, generated
// photos and a helper that takes a listing through the whole wizard.
const request = require('supertest');
const sharp = require('sharp');
const h = require('../helpers');
const { Master, AgreementTemplate } = require('../../src/modules/cms/models');
const { ensureBaseMasters } = require('../../src/modules/cms/baseMasters');

const TEMPLATE = (basis) => `CHANNEL PARTNER COMMISSION AGREEMENT between {{listerName}} and {{companyName}} for {{propertyRef}}. Commission {{commissionPercent}}% of the ${basis} plus GST, payable on a verified deal. Non-circumvention: also payable if a buyer introduced by the platform buys within {{nonCircumventionMonths}} months. Accepted by {{acceptedName}} on {{acceptedAt}}.`;

async function world() {
  await ensureBaseMasters();
  const city = await Master.findOneAndUpdate({ type: 'city', code: 'pune' }, { $setOnInsert: { type: 'city', code: 'pune', name: 'Pune', slug: 'pune', meta: { state: 'Maharashtra', centroid: { type: 'Point', coordinates: [73.8567, 18.5204] } } } }, { upsert: true, new: true });
  const baner = await Master.findOneAndUpdate({ type: 'locality', code: 'baner' }, { $setOnInsert: { type: 'locality', code: 'baner', name: 'Baner', slug: 'baner', parentId: city._id, meta: { centroid: { type: 'Point', coordinates: [73.7868, 18.559] } } } }, { upsert: true, new: true });
  for (const [purpose, basis] of [['sale', 'agreed sale price'], ['rent', 'annual rent'], ['project', 'unit sale price']]) {
    await AgreementTemplate.updateOne({ purpose, version: 1 }, { $setOnInsert: { purpose, version: 1, body: TEMPLATE(basis), status: 'published', publishedAt: new Date() } }, { upsert: true });
  }
  return { city, baner };
}

// Verified lister created directly (the KYC flow itself is covered in F.kyc.test.js).
async function verifiedLister(listerType = 'owner', extra = {}) {
  const l = await h.userWithToken('lister', { listerType, kyc: { status: 'verified', legalName: 'Asha Owner' }, ...extra });
  return { ...l, t: h.bearer(l.token) };
}

let colour = 0;
// A real JPEG with EXIF (including GPS) so the stripping can be asserted.
async function photo({ width = 1280, height = 960 } = {}) {
  colour = (colour + 37) % 255;
  return sharp({ create: { width, height, channels: 3, background: { r: colour, g: (colour * 3) % 255, b: (colour * 7) % 255 } } })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${(colour * 5) % width}" cy="${(colour * 3) % height}" r="200" fill="white"/></svg>`), top: 0, left: 0 }])
    .jpeg()
    .withExif({ IFD0: { Copyright: 'test', Artist: 'camera' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '18/1 33/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '73/1 47/1 0/1' } })
    .toBuffer();
}

async function upload(app, token, purpose, buffer, filename, contentType) {
  const r = await request(app).post(`/api/uploads?purpose=${purpose}`).set(h.bearer(token)).attach('file', buffer, { filename, contentType });
  if (r.status !== 201) throw new Error(`upload ${purpose} failed: ${JSON.stringify(r.body)}`);
  return r.body.data;
}

const PDF = (tag) => Buffer.from(`%PDF-1.4\n%${tag}\n`);

const STEP = (w, purpose = 'sale') => ({
  1: { purpose, category: 'residential', type: 'apartment', title: '2 BHK apartment in Baner with park view', description: 'Bright two bedroom apartment on the 5th floor with a balcony facing the park, covered parking and 24x7 security.' },
  2: { cityId: String(w.city._id), localityId: String(w.baner._id), addressLine: 'Flat 504, Green Park Society, Baner Road', unitNo: `504-${Math.random().toString(36).slice(2, 6)}`, pincode: '411045', lat: 18.5605, lng: 73.7875, landmarks: [{ type: 'it_park', name: 'Balewadi IT park', distanceKm: 2 }] },
  3: { bhk: 2, baths: 2, areas: { carpet: 750, builtUp: 900, superBuiltUp: 1100, unit: 'sqft' }, floor: 5, totalFloors: 12, furnishing: 'semi' },
  4: purpose === 'sale' ? { amount: 8500000, negotiable: true } : { monthlyRent: 32000, deposit: 100000 },
  5: { amenities: ['lift', 'gym', 'security'] },
});

// Takes a listing through steps 1-7. Returns { id, listing }.
async function fullListing(app, lister, w, { purpose = 'sale', percent, photos = 3, proof = true } = {}) {
  const draft = await request(app).post('/api/lister/properties').set(lister.t);
  const id = draft.body.data._id;
  const steps = STEP(w, purpose);
  for (const s of [1, 2, 3, 4, 5]) {
    const r = await request(app).patch(`/api/lister/properties/${id}/steps/${s}`).set(lister.t).send(steps[s]);
    if (r.status !== 200) throw new Error(`step ${s}: ${JSON.stringify(r.body)}`);
  }
  for (let i = 0; i < photos; i += 1) {
    const f = await upload(app, lister.token, 'property_photo', await photo(), `p${i}.jpg`, 'image/jpeg');
    await request(app).post(`/api/lister/properties/${id}/media`).set(lister.t).send({ kind: 'photo', fileId: f.id, caption: `Photo ${i + 1}` }).expect(201);
  }
  if (proof) {
    const f = await upload(app, lister.token, 'ownership_proof', PDF(`deed-${id}`), 'deed.pdf', 'application/pdf');
    await request(app).post(`/api/lister/properties/${id}/media`).set(lister.t).send({ kind: 'ownership_proof', fileId: f.id, docType: 'sale_deed' }).expect(201);
  }
  const c = await request(app).post(`/api/lister/properties/${id}/commission`).set(lister.t).send({ percent: percent || (purpose === 'sale' ? 2 : 8.33), accept: true, typedName: 'Asha Owner' });
  if (c.status !== 200) throw new Error(`commission: ${JSON.stringify(c.body)}`);
  return { id, agreementId: c.body.data.agreementId };
}

// Approves a submitted listing as a super admin (moderates every photo, ticks the checklist).
async function approve(app, adminToken, id, { builder = false } = {}) {
  const A = h.bearer(adminToken);
  const view = await request(app).get(`/api/admin/properties/${id}`).set(A);
  for (const ph of view.body.data.media.photos) await request(app).patch(`/api/admin/properties/${id}/media/${ph._id}/moderation`).set(A).send({ status: 'approved' });
  await request(app).post(`/api/admin/properties/${id}/claim`).set(A);
  const checklist = Object.fromEntries([...view.body.data.checklist, ...(builder ? ['rera_verified'] : [])].map((k) => [k, true]));
  return request(app).post(`/api/admin/properties/${id}/decision`).set(A).send({ decision: 'approve', checklist, proofOwnerName: 'Asha Owner' });
}

module.exports = { world, verifiedLister, photo, upload, PDF, STEP, fullListing, approve, TEMPLATE };
