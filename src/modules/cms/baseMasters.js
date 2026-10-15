// Base masters needed by every environment: property types, amenities,
// landmark types and the KYC document types required per lister type.
// Used by scripts/seed.js and by tests. Idempotent.
const { Master } = require('./models');

const PROPERTY_TYPES = [
  ['apartment', 'Apartment', 'residential'], ['independent_house', 'Independent House', 'residential'], ['villa', 'Villa', 'residential'],
  ['builder_floor', 'Builder Floor', 'residential'], ['residential_plot', 'Residential Plot', 'land'], ['office', 'Office Space', 'commercial'],
  ['shop', 'Shop', 'commercial'], ['showroom', 'Showroom', 'commercial'], ['warehouse', 'Warehouse', 'commercial'],
  ['agricultural_land', 'Agricultural Land', 'land'], ['industrial_land', 'Industrial Land', 'land'],
];
const AMENITIES = ['lift', 'power_backup', 'security', 'gym', 'swimming_pool', 'club_house', 'park', 'parking', 'gas_pipeline', 'rainwater_harvesting'];
const LANDMARK_TYPES = ['metro', 'railway', 'bus_stop', 'school', 'hospital', 'mall', 'it_park', 'airport', 'highway', 'market'];
// [code, name, appliesTo, required]
const DOC_TYPES = [
  ['id_proof', 'Identity proof (Aadhaar masked / passport / voter ID)', ['owner', 'landlord'], true],
  ['pan_card', 'PAN card', ['owner', 'landlord'], true],
  ['address_proof', 'Address proof', ['owner', 'landlord'], false],
  ['incorporation_certificate', 'Company incorporation / registration', ['builder'], true],
  ['signatory_id', 'Authorised signatory ID', ['builder'], true],
  ['authorisation_letter', 'Board resolution / authorisation letter', ['builder'], true],
  ['rera_registration', 'RERA registration (promoter)', ['builder'], false],
  ['company_pan', 'Company PAN', ['builder'], false],
];

const upsert = (type, code, doc) => Master.updateOne({ type, code }, { $setOnInsert: { type, code, ...doc } }, { upsert: true });
const title = (c) => c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

async function ensureBaseMasters() {
  for (const [i, [code, name, category]] of PROPERTY_TYPES.entries()) await upsert('property_type', code, { name, sort: i, meta: { category } });
  for (const [i, code] of AMENITIES.entries()) await upsert('amenity', code, { name: title(code), sort: i });
  for (const [i, code] of LANDMARK_TYPES.entries()) await upsert('landmark_type', code, { name: title(code), sort: i });
  for (const [i, [code, name, appliesTo, required]] of DOC_TYPES.entries()) await upsert('doc_type', code, { name, sort: i, meta: { appliesTo, required } });
}

module.exports = { ensureBaseMasters, PROPERTY_TYPES, AMENITIES, DOC_TYPES };
