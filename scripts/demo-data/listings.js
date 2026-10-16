// Listings through the real wizard (createDraft -> steps 1-6 -> media ->
// commission -> submit) and the admin review queue (claim -> photo moderation
// -> approve / changes / reject). Each listing is matched by lister + title and
// driven towards its target status from wherever it is, so reruns converge.
const { Property } = require('../../src/modules/listings/models');
const { User } = require('../../src/modules/auth/models');
const listings = require('../../src/modules/listings/service');
const review = require('../../src/modules/approvals/review.service');
const media = require('./media');
const { fakeReq, step, col, daysAgo, daysAhead } = require('./context');

const PIN = { baner: '411045', wakad: '411057', kharadi: '411014', hinjewadi: '411057', kothrud: '411038', 'viman-nagar': '411014' };
const ROOMS = {
  apartment: [['Living room', 'living'], ['Kitchen', 'kitchen'], ['Master bedroom', 'bedroom'], ['Balcony view', 'balcony'], ['Bathroom', 'bathroom'], ['Building exterior', 'exterior']],
  independent_house: [['Front elevation', 'exterior'], ['Living hall', 'living'], ['Kitchen', 'kitchen'], ['Bedroom', 'bedroom'], ['Garden', 'garden']],
  villa: [['Villa exterior', 'exterior'], ['Private garden', 'garden'], ['Living room', 'living'], ['Bedroom', 'bedroom'], ['Kitchen', 'kitchen']],
  residential_plot: [['Plot from the road', 'exterior'], ['Plot boundary', 'exterior'], ['Approach road', 'exterior']],
  office: [['Reception', 'living'], ['Workstations', 'other'], ['Cabin', 'other'], ['Pantry', 'kitchen']],
  shop: [['Shop front', 'exterior'], ['Inside the shop', 'other'], ['Street view', 'exterior']],
};
const STD = ['lift', 'power_backup', 'security', 'parking'];
const LM = {
  baner: [{ type: 'mall', name: 'Westend Mall', distanceKm: 2.5 }, { type: 'school', name: 'Vibgyor High School', distanceKm: 1.2 }],
  wakad: [{ type: 'it_park', name: 'Hinjewadi Phase 1', distanceKm: 4 }, { type: 'hospital', name: 'Aditya Birla Memorial Hospital', distanceKm: 3 }, { type: 'highway', name: 'Mumbai Pune Expressway', distanceKm: 1.5 }],
  kharadi: [{ type: 'it_park', name: 'EON IT Park', distanceKm: 1 }, { type: 'mall', name: 'Phoenix Marketcity', distanceKm: 5 }],
  hinjewadi: [{ type: 'it_park', name: 'Rajiv Gandhi Infotech Park', distanceKm: 1.5 }, { type: 'bus_stop', name: 'Hinjewadi Phase 1 bus stop', distanceKm: 0.4 }],
  kothrud: [{ type: 'metro', name: 'Vanaz Metro Station', distanceKm: 1 }, { type: 'market', name: 'Karve Road market', distanceKm: 0.8 }],
  'viman-nagar': [{ type: 'airport', name: 'Pune Airport', distanceKm: 3 }, { type: 'mall', name: 'Phoenix Marketcity', distanceKm: 1.5 }],
};

const L = (o) => o;
// target: draft | pending_approval | changes_requested | rejected | live (live listings may get a `then` lifecycle step later).
const LISTINGS = [
  // ---- owner@demo.local (Demo Owner)
  L({ key: 'o1', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'wakad', society: 'Palm Grove', title: '2 BHK in Wakad with clubhouse access', bhk: 2, area: { carpet: 780, builtUp: 950, superBuiltUp: 1150 }, floor: 7, totalFloors: 14, furnishing: 'semi', facing: 'East', ageYears: 4, amount: 9200000, maintenance: 3200, negotiable: true, amenities: [...STD, 'gym', 'swimming_pool', 'club_house'], video: 'https://www.youtube.com/watch?v=ysz5S6PUM-U', floorPlan: true, featured: true, target: 'live', photos: 5 }),
  L({ key: 'o2', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'independent_house', locality: 'kothrud', society: 'Mayur Colony', title: '4 BHK independent bungalow in Kothrud', bhk: 4, baths: 4, area: { builtUp: 2600, plot: 3200 }, totalFloors: 2, furnishing: 'full', facing: 'North', ageYears: 12, amount: 34000000, negotiable: true, amenities: ['parking', 'security', 'power_backup', 'rainwater_harvesting'], extra: { plotAreaSqft: 3200, floorsAllowed: 3 }, target: 'live', photos: 5 }),
  L({ key: 'o3', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'villa', locality: 'baner', society: 'Aundh Baner Villas', title: '3 BHK villa in Baner with private garden', bhk: 3, area: { builtUp: 2100, plot: 2800 }, totalFloors: 2, furnishing: 'semi', ageYears: 6, amount: 27500000, amenities: ['parking', 'security', 'park', 'club_house'], target: 'live', photos: 4 }),
  L({ key: 'o4', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'hinjewadi', society: 'Megapolis Sunway', title: '1 BHK starter flat near Hinjewadi Phase 2', bhk: 1, area: { carpet: 430, builtUp: 520 }, floor: 11, totalFloors: 22, furnishing: 'unfurnished', ageYears: 3, amount: 4100000, amenities: STD, target: 'live', photos: 3 }),
  L({ key: 'o5', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'viman-nagar', society: 'Sky Blue Society', title: '2 BHK in Viman Nagar, airport side', bhk: 2, area: { carpet: 700, builtUp: 860 }, floor: 3, totalFloors: 7, furnishing: 'semi', ageYears: 15, amount: 9800000, amenities: STD, target: 'rejected', photos: 3, rejectReason: 'Ownership proof is in a different name than the KYC and no authorisation letter was given' }),
  L({ key: 'o6', lister: 'owner@demo.local', purpose: 'sale', category: 'land', type: 'residential_plot', locality: 'hinjewadi', society: 'Green Acres Layout', title: '1800 sq ft residential plot in Hinjewadi', area: { plot: 1800 }, amount: 7200000, negotiable: true, amenities: [], extra: { boundaryWall: true, cornerPlot: false }, target: 'pending_approval', claim: true, photos: 3 }),
  L({ key: 'o7', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'kharadi', society: 'Gera World of Joy', title: '3 BHK in Kharadi near EON IT Park', bhk: 3, area: { carpet: 1080, builtUp: 1300 }, floor: 9, totalFloors: 18, furnishing: 'unfurnished', ageYears: 2, amount: 15200000, amenities: [...STD, 'gym', 'club_house'], target: 'changes_requested', photos: 4,
    comments: [{ field: 'media', comment: 'Two photos look like brochure renders; please add real photos of the flat' }, { field: 'price', comment: 'Price per sq ft is well above the locality median; please confirm' }] }),
  L({ key: 'o8', lister: 'owner@demo.local', purpose: 'sale', category: 'commercial', type: 'office', locality: 'baner', title: 'Office space in Baner (draft)', area: { carpet: 650 }, target: 'draft', partial: [1, 2] }),
  L({ key: 'o9', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'baner', society: 'Pebbles Urbania', title: '2 BHK Baner, ready to move', bhk: 2, area: { carpet: 760, builtUp: 920 }, floor: 4, totalFloors: 12, furnishing: 'semi', ageYears: 5, amount: 11000000, amenities: [...STD, 'gym'], target: 'live', photos: 4 }),
  L({ key: 'o10', lister: 'owner@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'wakad', society: 'Kalpataru Exquisite', title: '3 BHK Wakad with two covered parkings', bhk: 3, area: { carpet: 1050, builtUp: 1250, superBuiltUp: 1500 }, floor: 12, totalFloors: 20, furnishing: 'full', ageYears: 3, amount: 14500000, parking: { covered: 2, open: 0 }, amenities: [...STD, 'gym', 'swimming_pool'], target: 'live', photos: 4 }),

  // ---- landlord@demo.local (Rohan Kulkarni)
  L({ key: 'r1', lister: 'landlord@demo.local', purpose: 'rent', category: 'residential', type: 'apartment', locality: 'kharadi', society: 'Marvel Zephyr', title: 'Furnished 2 BHK for rent in Kharadi', bhk: 2, area: { carpet: 820, builtUp: 980 }, floor: 6, totalFloors: 15, furnishing: 'full', ageYears: 7, monthlyRent: 32000, deposit: 100000, maintenance: 3500, amenities: [...STD, 'gym', 'swimming_pool'], extra: { preferredTenants: 'family', petsAllowed: false }, featured: true, target: 'live', photos: 5 }),
  L({ key: 'r2', lister: 'landlord@demo.local', purpose: 'rent', category: 'residential', type: 'apartment', locality: 'viman-nagar', society: 'Konark Nagar', title: '1 BHK near Phoenix Marketcity, Viman Nagar', bhk: 1, area: { carpet: 480 }, floor: 2, totalFloors: 5, furnishing: 'semi', ageYears: 10, monthlyRent: 19000, deposit: 60000, negotiable: true, amenities: STD, extra: { preferredTenants: 'bachelors' }, target: 'live', photos: 4 }),
  L({ key: 'r3', lister: 'landlord@demo.local', purpose: 'rent', category: 'residential', type: 'apartment', locality: 'baner', society: 'Rohan Leher', title: 'Spacious 3 BHK for rent in Baner', bhk: 3, area: { carpet: 1150, builtUp: 1400 }, floor: 8, totalFloors: 12, furnishing: 'unfurnished', ageYears: 6, monthlyRent: 45000, deposit: 200000, maintenance: 4500, amenities: [...STD, 'club_house'], target: 'live', photos: 4 }),
  L({ key: 'r4', lister: 'landlord@demo.local', purpose: 'rent', category: 'residential', type: 'independent_house', locality: 'kothrud', title: 'Independent house for rent in Kothrud', bhk: 3, area: { builtUp: 1600, plot: 2000 }, totalFloors: 2, furnishing: 'semi', ageYears: 20, monthlyRent: 38000, deposit: 150000, amenities: ['parking'], target: 'live', photos: 3 }),
  L({ key: 'r5', lister: 'landlord@demo.local', purpose: 'rent', category: 'commercial', type: 'office', locality: 'hinjewadi', society: 'Embassy Quadron', title: 'Furnished office for rent in Hinjewadi Phase 1', area: { carpet: 1800, superBuiltUp: 2400 }, floor: 3, totalFloors: 9, furnishing: 'full', ageYears: 5, monthlyRent: 150000, deposit: 900000, maintenance: 18000, amenities: ['lift', 'power_backup', 'security', 'parking'], extra: { workstations: 30, cabins: 3, washrooms: 2 }, target: 'live', photos: 4 }),
  L({ key: 'r6', lister: 'landlord@demo.local', purpose: 'rent', category: 'commercial', type: 'shop', locality: 'wakad', title: 'Ground floor shop for rent on Wakad main road', area: { carpet: 350 }, floor: 0, totalFloors: 3, furnishing: 'unfurnished', ageYears: 8, monthlyRent: 42000, deposit: 250000, amenities: ['power_backup', 'parking'], extra: { frontageFt: 18 }, target: 'live', photos: 3 }),
  L({ key: 'r7', lister: 'landlord@demo.local', purpose: 'rent', category: 'residential', type: 'apartment', locality: 'wakad', society: 'Shubh Gateway', title: '2 BHK for rent in Wakad, family preferred', bhk: 2, area: { carpet: 750 }, floor: 4, totalFloors: 11, furnishing: 'semi', ageYears: 4, monthlyRent: 24000, deposit: 75000, maintenance: 2500, amenities: [...STD, 'gym'], extra: { preferredTenants: 'family' }, target: 'live', photos: 4 }),

  // ---- owner2@demo.local (Sneha Patil, billing in Karnataka -> IGST invoices)
  L({ key: 's1', lister: 'owner2@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'kothrud', society: 'Ideal Colony', title: '2 BHK apartment in Kothrud near MIT college', bhk: 2, area: { carpet: 690, builtUp: 840 }, floor: 2, totalFloors: 6, furnishing: 'semi', ageYears: 18, amount: 9500000, amenities: STD, target: 'live', photos: 4 }),
  L({ key: 's2', lister: 'owner2@demo.local', purpose: 'sale', category: 'commercial', type: 'shop', locality: 'baner', title: 'Corner shop for sale on Baner high street', area: { carpet: 420 }, floor: 0, totalFloors: 4, furnishing: 'unfurnished', ageYears: 5, amount: 16500000, negotiable: true, amenities: ['power_backup', 'parking'], target: 'live', photos: 4, rejectPhoto: true }),
  L({ key: 's3', lister: 'owner2@demo.local', purpose: 'sale', category: 'commercial', type: 'office', locality: 'kharadi', society: 'World Trade Center', title: 'Office floor for sale in Kharadi', area: { carpet: 2200, superBuiltUp: 3000 }, floor: 10, totalFloors: 22, furnishing: 'semi', ageYears: 4, amount: 42000000, amenities: ['lift', 'power_backup', 'security', 'parking'], target: 'live', photos: 4 }),
  L({ key: 's4', lister: 'owner2@demo.local', purpose: 'sale', category: 'residential', type: 'independent_house', locality: 'wakad', society: 'Vision Row Houses', title: 'Row house for sale in Wakad', bhk: 3, area: { builtUp: 1700, plot: 1500 }, totalFloors: 2, furnishing: 'semi', ageYears: 9, amount: 19000000, amenities: ['parking', 'security', 'park'], target: 'live', photos: 4 }),
  L({ key: 's5', lister: 'owner2@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'viman-nagar', society: 'Clover Highlands', title: '3 BHK in Viman Nagar with lake view', bhk: 3, area: { carpet: 1120, builtUp: 1350 }, floor: 14, totalFloors: 16, furnishing: 'full', ageYears: 6, amount: 21000000, amenities: [...STD, 'swimming_pool', 'gym'], target: 'live', photos: 4 }),
  L({ key: 's6', lister: 'owner2@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'baner', society: 'Kumar Pebble Park', title: '2.5 BHK in Baner near Balewadi stadium', bhk: 2, area: { carpet: 880, builtUp: 1050 }, floor: 5, totalFloors: 10, furnishing: 'semi', ageYears: 8, amount: 12800000, amenities: [...STD, 'park'], target: 'live', photos: 4 }),

  // ---- owner5@demo.local (listing limit 2: the third submission raises broker rule R2)
  L({ key: 'p1', lister: 'owner5@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'wakad', society: 'Ganga Glitz', title: '1 BHK in Wakad for first-time buyers', bhk: 1, area: { carpet: 450, builtUp: 560 }, floor: 6, totalFloors: 12, furnishing: 'unfurnished', ageYears: 2, amount: 4800000, amenities: STD, target: 'live', photos: 3 }),
  L({ key: 'p2', lister: 'owner5@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'hinjewadi', society: 'Blue Ridge', title: '2 BHK in Hinjewadi Phase 1', bhk: 2, area: { carpet: 740 }, floor: 9, totalFloors: 21, furnishing: 'semi', ageYears: 7, amount: 7600000, amenities: [...STD, 'gym', 'swimming_pool'], target: 'live', photos: 3 }),
  L({ key: 'p3', lister: 'owner5@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'kothrud', society: 'Shivtirth Nagar', title: '2 BHK resale flat in Kothrud', bhk: 2, area: { carpet: 650 }, floor: 1, totalFloors: 4, furnishing: 'unfurnished', ageYears: 22, amount: 8200000, amenities: ['parking'], target: 'pending_approval', photos: 3 }),

  // ---- KYC not verified yet / rejected / banned listers
  L({ key: 'q1', lister: 'owner3@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'baner', society: 'Sai Prasad Heights', title: '2 BHK in Baner waiting for KYC', bhk: 2, area: { carpet: 720 }, floor: 3, totalFloors: 8, furnishing: 'semi', ageYears: 9, amount: 9900000, amenities: STD, target: 'pending_approval', photos: 3 }),
  L({ key: 'd1', lister: 'landlord2@demo.local', purpose: 'rent', category: 'residential', type: 'apartment', locality: 'kharadi', title: '2 BHK for rent in Kharadi (draft)', bhk: 2, area: { carpet: 800 }, monthlyRent: 28000, target: 'draft', partial: [1, 2, 3] }),
  L({ key: 'v1', lister: 'owner4@demo.local', purpose: 'sale', category: 'residential', type: 'apartment', locality: 'kothrud', society: 'Paud Road Residency', title: '3 BHK on Paud Road, Kothrud', bhk: 3, area: { carpet: 980 }, floor: 4, totalFloors: 7, furnishing: 'semi', ageYears: 11, amount: 13500000, amenities: STD, target: 'live', photos: 3 }),
  L({ key: 'x1', lister: 'broker.suspect@demo.local', purpose: 'rent', category: 'residential', type: 'apartment', locality: 'hinjewadi', society: 'Xrbia', title: '1 BHK rent near Hinjewadi bus stop', bhk: 1, area: { carpet: 420 }, floor: 5, totalFloors: 14, furnishing: 'semi', ageYears: 3, monthlyRent: 14000, deposit: 40000, amenities: STD, target: 'live', photos: 3 }),

  // ---- builders: unit listings linked to live projects, and one RERA-exempt villa
  L({ key: 'b1', lister: 'builder@demo.local', project: 'heights', config: '2 BHK Type A', purpose: 'sale', category: 'residential', type: 'apartment', title: 'Skyline Heights 2 BHK, tower A', unitNo: 'A-702', bhk: 2, area: { carpet: 740, builtUp: 900 }, floor: 7, totalFloors: 18, furnishing: 'unfurnished', possession: 'under_construction', amount: 9000000, target: 'live', photos: 4 }),
  L({ key: 'b2', lister: 'builder@demo.local', project: 'heights', config: '3 BHK Type B', purpose: 'sale', category: 'residential', type: 'apartment', title: 'Skyline Heights 3 BHK corner home', unitNo: 'B-1104', bhk: 3, area: { carpet: 1080, builtUp: 1300 }, floor: 11, totalFloors: 18, furnishing: 'unfurnished', possession: 'under_construction', amount: 13200000, target: 'live', photos: 4 }),
  L({ key: 'b3', lister: 'builder2@demo.local', project: 'greens', config: '2 BHK Classic', purpose: 'sale', category: 'residential', type: 'apartment', title: 'Riverstone Greens 2 BHK, tower A', unitNo: 'A-401', bhk: 2, area: { carpet: 760, builtUp: 930 }, floor: 4, totalFloors: 22, furnishing: 'unfurnished', possession: 'under_construction', amount: 8700000, target: 'live', photos: 4 }),
  L({ key: 'b4', lister: 'builder2@demo.local', project: 'greens', config: '3 BHK Grande', purpose: 'sale', category: 'residential', type: 'apartment', title: 'Riverstone Greens 3 BHK park facing', unitNo: 'B-1201', bhk: 3, area: { carpet: 1120, builtUp: 1360 }, floor: 12, totalFloors: 22, furnishing: 'unfurnished', possession: 'under_construction', amount: 13600000, target: 'live', photos: 4 }),
  L({ key: 'b5', lister: 'builder2@demo.local', purpose: 'sale', category: 'residential', type: 'villa', locality: 'baner', society: 'Riverstone Enclave', title: '4 BHK villa in Riverstone Enclave, Baner', bhk: 4, area: { builtUp: 3200, plot: 4000 }, totalFloors: 3, furnishing: 'semi', possession: 'ready', amount: 52000000, amenities: ['parking', 'security', 'park', 'club_house', 'swimming_pool'], reraExempt: true, brochure: true, target: 'live', photos: 5 }),
];

const DESC = (s, loc) => {
  const what = { apartment: `${s.bhk || ''} BHK apartment`.trim(), independent_house: 'independent house', villa: 'villa', residential_plot: 'residential plot', office: 'office space', shop: 'shop' }[s.type];
  const deal = s.purpose === 'rent' ? 'available on rent' : 'for sale';
  return `Well kept ${what} ${deal} in ${loc}${s.society ? ` in ${s.society}` : ''}. Good natural light, cross ventilation and a quiet internal road. `
    + `Daily needs, schools and hospitals are close by and the main road is a short walk away. Visits are arranged by our sales team at a time that suits you.`;
};

function locationFor(ctx, s) {
  const l = ctx.localities[s.locality];
  const seed = [...s.key].reduce((a, c) => a + c.charCodeAt(0), 0);
  const [lng, lat] = l.centroid;
  return {
    cityId: String(ctx.cityId), localityId: String(l._id), societyName: s.society, addressLine: `${s.society ? `${s.society}, ` : ''}${l.name}, Pune`,
    unitNo: s.unitNo || (s.type === 'residential_plot' ? `Plot ${seed % 90}` : `${(seed % 9) + 1}0${seed % 4 + 1}`), pincode: PIN[s.locality],
    lat: +(lat + ((seed % 17) - 8) * 0.0009).toFixed(6), lng: +(lng + ((seed % 13) - 6) * 0.0009).toFixed(6), landmarks: LM[s.locality] || [],
  };
}

const ensureCtx = (ctx) => { ctx.listings = ctx.listings || {}; return ctx; };

async function runSteps(ctx, s, user, p, req) {
  const id = String(p._id);
  const want = s.partial || [1, 2, 3, 4, 5, 6];
  const done = p.wizard.stepsDone || [];
  const linked = Boolean(s.project);
  const loc = linked ? null : locationFor(ctx, s);
  const locName = linked ? ctx.projects[s.project].location.locality : ctx.localities[s.locality].name;
  if (want.includes(1) && !done.includes(1)) await listings.saveStep(user, id, 1, { purpose: s.purpose, category: s.category, type: s.type, title: s.title, description: DESC(s, locName) }, req);
  if (want.includes(2) && !done.includes(2)) await listings.saveStep(user, id, 2, linked ? { unitNo: s.unitNo } : loc, req);
  if (linked && s.unitNo && !(p.location && p.location.unitNo)) await listings.saveStep(user, id, 2, { unitNo: s.unitNo }, req);
  if (want.includes(3) && !done.includes(3)) {
    await listings.saveStep(user, id, 3, {
      bhk: s.bhk, baths: s.baths || (s.bhk ? Math.max(1, s.bhk) : undefined), balconies: s.bhk ? Math.min(2, s.bhk) : undefined,
      areas: { ...s.area, unit: 'sqft' }, floor: s.floor, totalFloors: s.totalFloors, furnishing: s.furnishing, facing: s.facing || (s.bhk ? 'East' : undefined), ageYears: s.ageYears,
      possession: s.possession === 'under_construction' ? { status: 'under_construction', date: daysAhead(540) } : { status: 'ready' },
      parking: s.parking || (s.category === 'land' ? undefined : { covered: 1, open: 0 }), extra: s.extra,
    }, req);
  }
  if (want.includes(4) && !done.includes(4) && (s.amount || s.monthlyRent)) {
    await listings.saveStep(user, id, 4, { amount: s.amount, monthlyRent: s.monthlyRent, deposit: s.deposit, maintenance: s.maintenance, negotiable: Boolean(s.negotiable), allInclusive: Boolean(s.purpose === 'rent' && !s.maintenance) }, req);
  }
  if (want.includes(5) && !done.includes(5) && !linked) await listings.saveStep(user, id, 5, { amenities: s.amenities || [] }, req);
  if (want.includes(6) && !done.includes(6)) {
    const d6 = {};
    if (s.video) d6.video = { kind: 'youtube', url: s.video };
    if (s.reraExempt) {
      const plan = await media.uploadPdf(user._id, 'rera_certificate', `Sanctioned plan - ${s.title}`, ['Sanctioned plan for six villas (demo)'], `plan:${s.key}`);
      d6.rera = { numbers: [], exempt: { reason: 'upto_8_units', plotAreaSqm: 380, units: 6, docFileId: String(plan._id) } };
    }
    await listings.saveStep(user, id, 6, d6, req);
  }
}

async function addMedia(ctx, s, user, p, req) {
  const id = String(p._id);
  const rooms = ROOMS[s.type] || ROOMS.apartment;
  const have = (p.media.photos || []).length;
  for (let i = have; i < (s.photos || 0); i += 1) {
    const [label, tag] = rooms[i % rooms.length];
    const f = await media.uploadPhoto(user._id, 'property_photo', label, `${s.key}:${i}`, { sub: s.title, category: media.categoryFor({ type: s.type, category: s.category, tag, label }) });
    await listings.addMedia(user, id, { kind: 'photo', fileId: String(f._id), caption: `${label}${i === 0 ? ' (cover)' : ''}`, tag }, req);
  }
  const fresh = await Property.findById(id);
  if (s.floorPlan && !(fresh.media.floorPlans || []).length) {
    const f = await media.uploadPhoto(user._id, 'floor_plan', 'Floor plan', `${s.key}:fp`, { sub: `${s.bhk} BHK, ${s.area.carpet} sq ft carpet` });
    await listings.addMedia(user, id, { kind: 'floor_plan', fileId: String(f._id), label: `${s.bhk} BHK layout` }, req);
  }
  if (s.brochure && !(fresh.media.brochure && fresh.media.brochure.url)) {
    const f = await media.uploadPdf(user._id, 'brochure', `${s.title} brochure`, ['Specifications', 'Teak wood doors, Italian marble flooring'], `${s.key}:brochure`);
    await listings.addMedia(user, id, { kind: 'brochure', fileId: String(f._id) }, req);
  }
  if (user.listerType !== 'builder' && !(fresh.media.ownershipProofs || []).length && s.target !== 'draft') {
    const docType = s.purpose === 'rent' ? 'property_tax_receipt' : 'sale_deed';
    const f = await media.uploadPdf(user._id, 'ownership_proof', `${docType.replace(/_/g, ' ')} - ${s.title}`, [`Owner: ${user.name}`], `${s.key}:proof`);
    await listings.addMedia(user, id, { kind: 'ownership_proof', fileId: String(f._id), docType }, req);
  }
}

async function commission(ctx, s, user, p, req) {
  if (p.activeAgreementId) return;
  let percent = s.purpose === 'rent' ? 8.33 : 2;
  if (s.project) percent = Math.max(percent, (ctx.projects[s.project].commission && ctx.projects[s.project].commission.percent) || 2) + 0.5;
  if (s.key === 'o9' || s.key === 's5') percent = 1.5;
  await listings.acceptCommission(user, String(p._id), { percent, accept: true, typedName: user.name }, req);
}

async function adminDecide(ctx, p, decision, s) {
  const admin = ctx.users.admin;
  const req = fakeReq(admin);
  await review.claim(String(p._id), req);
  if (decision === 'claim') return;
  const fresh = await Property.findById(p._id);
  const lister = await User.findById(p.listerId);
  for (const [i, ph] of fresh.media.photos.entries()) {
    if (ph.moderation.status !== 'pending') continue;
    const reject = s.rejectPhoto && i === fresh.media.photos.length - 1;
    await review.moderateMedia(String(p._id), String(ph._id), reject ? { status: 'rejected', reason: 'Watermark of another website visible' } : { status: 'approved' }, req);
  }
  const checklist = Object.fromEntries([...review.CHECKLIST, ...(lister.listerType === 'builder' ? review.BUILDER_CHECKLIST : [])].map((k) => [k, true]));
  if (decision === 'approve') await review.decide(String(p._id), { decision: 'approve', checklist, proofOwnerName: lister.listerType === 'builder' ? undefined : lister.name }, req);
  if (decision === 'changes') await review.decide(String(p._id), { decision: 'changes', comments: s.comments }, req);
  if (decision === 'reject') await review.decide(String(p._id), { decision: 'reject', reason: s.rejectReason }, req);
}

async function ensureListing(ctx, s) {
  const user = await User.findOne({ email: s.lister });
  const req = fakeReq(user);
  let p = await Property.findOne({ listerId: user._id, title: s.title, deletedAt: null });
  if (!p) {
    const body = s.project ? { projectId: String(ctx.projects[s.project]._id), unitConfigId: String(ctx.projects[s.project].configurations.find((c) => c.name === s.config)._id) } : {};
    p = await listings.createDraft(user, { ...req, body });
  }
  if (['draft', 'changes_requested'].includes(p.status)) {
    await runSteps(ctx, s, user, p, req);
    if (s.target !== 'draft') {
      p = await Property.findById(p._id);
      await addMedia(ctx, s, user, p, req);
      p = await Property.findById(p._id);
      await commission(ctx, s, user, p, req);
    }
    p = await Property.findById(p._id);
    // A listing that came back with changes is resubmitted only when the target says so.
    if (p.status === 'draft' && s.target !== 'draft') await listings.submit(user, String(p._id), req);
  }
  p = await Property.findById(p._id);
  if (p.status === 'pending_approval') {
    if (s.target === 'live') await adminDecide(ctx, p, 'approve', s);
    else if (s.target === 'changes_requested') await adminDecide(ctx, p, 'changes', s);
    else if (s.target === 'rejected') await adminDecide(ctx, p, 'reject', s);
    else if (s.claim && !(p.review && p.review.claimUntil > new Date())) await adminDecide(ctx, p, 'claim', s); // claims last 30 minutes
  }
  p = await Property.findById(p._id);
  if (s.featured && p.status === 'live' && !(p.featured && p.featured.on)) await review.adminAction(String(p._id), { action: 'feature', until: daysAhead(30) }, fakeReq(ctx.users.superadmin));
  ctx.listings[s.key] = await Property.findById(p._id);
  return true;
}

async function seedListings(ctx) {
  ensureCtx(ctx);
  // Listings needing a project are skipped when that project is not live.
  for (const s of LISTINGS) {
    if (s.project && !(ctx.projects[s.project] && ctx.projects[s.project].status === 'live')) { console.log(`  ! skip ${s.key}: project ${s.project} not live`); continue; }
    await step(`listing ${s.key} ${s.title}`, () => ensureListing(ctx, s));
  }
}

async function reloadListings(ctx) {
  ensureCtx(ctx);
  for (const s of LISTINGS) {
    const u = await User.findOne({ email: s.lister }).select('_id');
    const p = u && await Property.findOne({ listerId: u._id, title: s.title, deletedAt: null });
    if (p) ctx.listings[s.key] = p;
  }
}

module.exports = { seedListings, reloadListings, LISTINGS, locationFor };
