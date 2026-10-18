// Idempotent seed: super admin, launch-state masters (Pune, Maharashtra),
// property types, amenities, CMS pages and the first agreement templates
// (with the 6-month non-circumvention clause).   npm run seed
const bcrypt = require('bcryptjs');
const env = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const { User } = require('../src/modules/auth/models');
const { Master, Page, AgreementTemplate } = require('../src/modules/cms/models');
const { ensureBaseMasters } = require('../src/modules/cms/baseMasters');
const DEFAULT_PAGES = [...require('./default-pages'), ...require('./default-content-pages')];

const CITY = { code: 'pune', name: 'Pune', state: 'Maharashtra', centroid: [73.8567, 18.5204] };
const LOCALITIES = [['baner', 'Baner', [73.7868, 18.559]], ['wakad', 'Wakad', [73.7629, 18.5975]], ['kharadi', 'Kharadi', [73.9416, 18.5515]],
  ['hinjewadi', 'Hinjewadi', [73.7389, 18.5912]], ['kothrud', 'Kothrud', [73.8077, 18.5074]], ['viman-nagar', 'Viman Nagar', [73.9143, 18.5679]]];

const TEMPLATE = (basis) => `CHANNEL PARTNER COMMISSION AGREEMENT
Between {{listerName}} ("Lister") and {{companyName}} ("Platform").
1. The Lister appoints the Platform as its channel sales partner for {{propertyRef}}.
2. The Lister agrees to pay the Platform a commission of {{commissionPercent}}% of the ${basis} on a deal closed with a buyer or tenant introduced by the Platform, plus applicable GST.
3. Commission becomes payable when the Platform verifies the booking receipts; invoices are due within 30 days.
4. Non-circumvention: commission is also payable if a buyer or tenant introduced by the Platform buys or rents the property within {{nonCircumventionMonths}} months of the Platform's last contact with that buyer or tenant about the property.
5. The Lister confirms it is the owner, builder or landlord of the property and is not a broker.
Accepted electronically by {{acceptedName}} on {{acceptedAt}}.`;

async function upsert(Model, filter, doc) {
  await Model.updateOne(filter, { $setOnInsert: doc }, { upsert: true });
}

async function main() {
  await connectDb();
  if (!(await User.exists({ email: env.SEED_ADMIN_EMAIL.toLowerCase() }))) {
    await User.create({
      name: 'Super Admin', email: env.SEED_ADMIN_EMAIL, phone: '+919000000001', role: 'superadmin', status: 'active',
      passwordHash: await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 12), emailVerified: true, phoneVerified: true,
    });
    console.log(`Created super admin ${env.SEED_ADMIN_EMAIL}`);
  }
  await upsert(Master, { type: 'city', code: CITY.code }, { type: 'city', code: CITY.code, name: CITY.name, slug: CITY.code, meta: { state: CITY.state, centroid: { type: 'Point', coordinates: CITY.centroid } } });
  const city = await Master.findOne({ type: 'city', code: CITY.code });
  for (const [code, name, c] of LOCALITIES) {
    await upsert(Master, { type: 'locality', code }, { type: 'locality', code, name, slug: code, parentId: city._id, meta: { state: CITY.state, centroid: { type: 'Point', coordinates: c } } });
  }
  await ensureBaseMasters(); // property types, amenities, landmark types, KYC document types
  // Footer pages ship published with default text; a page an admin already wrote is left alone,
  // and an untouched empty draft from an older seed is filled in and published.
  for (const pg of DEFAULT_PAGES) {
    const doc = { title: pg.title, content: pg.content, meta: { title: pg.title, description: pg.description }, status: 'published', publishedAt: new Date() };
    await upsert(Page, { slug: pg.slug }, { slug: pg.slug, ...doc, versions: [{ version: 1, content: pg.content, savedAt: new Date() }] });
    await Page.updateOne({ slug: pg.slug, status: 'draft', content: { $in: ['', null] } }, { $set: doc, $push: { versions: { version: 1, content: pg.content, savedAt: new Date() } } });
  }
  for (const [purpose, basis] of [['sale', 'agreed sale price'], ['rent', 'annual rent (12 x monthly rent)'], ['project', 'agreed sale price of each unit']]) {
    await upsert(AgreementTemplate, { purpose, version: 1 }, { purpose, version: 1, body: TEMPLATE(basis), status: 'published', publishedAt: new Date() });
  }
  console.log('Seed complete');
  await disconnectDb();
}

main().catch(async (err) => { console.error(err); await disconnectDb(); process.exit(1); });
