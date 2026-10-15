// Phase 3+ fixtures: live listings inserted directly (search and leads only
// read stored listings, so the wizard is not needed here).
const { Property } = require('../../src/modules/listings/models');
const { publicPoint } = require('../../src/modules/listings/service');
const counters = require('../../src/core/counters');
const fx2 = require('../phase2/fixtures');
const h = require('../helpers');

let k = 0;
async function liveListing(w, lister, over = {}) {
  k += 1;
  const listingNo = await counters.listingNo();
  const lat = over.lat ?? 18.559 + (k % 7) * 0.002;
  const lng = over.lng ?? 73.7868 + (k % 5) * 0.002;
  const purpose = over.purpose || 'sale';
  const amount = over.amount ?? 8500000;
  const area = over.areaSqft ?? 750;
  const p = new Property({
    listingNo, slug: `test-listing-${listingNo.toLowerCase()}`, listerId: lister.user._id, status: over.status || 'live', purpose, category: over.category || 'residential', type: over.type || 'apartment',
    title: over.title || `${over.bhk ?? 2} BHK apartment in ${over.localityName || 'Baner'} number ${k}`, description: 'A bright and airy apartment with a balcony, covered parking and round-the-clock security in a quiet society.',
    location: {
      cityId: w.city._id, city: 'Pune', localityId: (over.locality || w.baner)._id, locality: over.localityName || 'Baner', societyName: 'Green Park', addressLine: 'Flat 504, Green Park Society, Baner Road',
      unitNo: `U-${k}`, pincode: '411045', geo: { type: 'Point', coordinates: [lng, lat] },
    },
    details: { bhk: over.bhk ?? 2, baths: 2, areaSqft: area, areas: { carpet: area, unit: 'sqft' }, furnishing: over.furnishing || 'semi', possession: { status: 'ready' } },
    price: purpose === 'sale' ? { amount: amount * 100, pricePerSqft: Math.round((amount * 100) / area) } : { monthlyRent: amount * 100, pricePerSqft: Math.round((amount * 100) / area) },
    amenities: over.amenities || ['lift', 'gym'],
    media: { photos: [{ url: 'http://x/p1.jpg', thumbUrl: 'http://x/t1.jpg', isCover: true, moderation: { status: 'approved' } }] },
    verification: over.verification || {}, featured: over.featured, liveAt: over.liveAt || new Date(), expiresAt: new Date(Date.now() + 90 * 86400000),
    commission: { percent: 2 }, wizard: { stepsDone: [1, 2, 3, 4, 5, 6, 7], completeness: 100 },
  });
  p.location.publicGeo = await publicPoint(p);
  await p.save();
  return p;
}

async function seedWorld() {
  const w = await fx2.world();
  const lister = await fx2.verifiedLister('owner', { phone: '+919800000001', email: 'secret.owner@example.com', name: 'Rahul Secret Owner' });
  return { w, lister };
}

module.exports = { liveListing, seedWorld, h };
