// Rich demo data for clicking through every panel locally (LOCAL dev database only).
//   cd backend && npm run seed:demo        (or: node scripts/seed-demo-data.js)
//
// - Never reads backend/.env: env comes from tests/env (dummy secrets) and the
//   database is mongodb://127.0.0.1:27040/re_dev unless SEED_MONGO_URI points at
//   another LOCAL database. Refuses non-local URIs and NODE_ENV=production.
// - Goes through the app's own services wherever practical (numbering, GST,
//   status machines, notifications, audit), with fake request objects.
// - Idempotent: records are matched by natural keys (email, listing title,
//   project name, buyer phone + property, ...) and driven towards their target
//   state, so a second run adds nothing new.
// - Uploaded files land in backend/uploads (served by the dev API at /uploads).
// - The demo password is the one in scripts/seed-demo-users.js (never printed).
const { loadSafeEnv } = require('./demo-data/safe-env');

loadSafeEnv();
const mongoose = require('mongoose');
const { User } = require('../src/modules/auth/models');
const { Master } = require('../src/modules/cms/models');
const settings = require('../src/core/settings');
const { stats, step, log, fakeReq } = require('./demo-data/context');

async function context() {
  const bcrypt = require('bcryptjs');
  const people = require('./demo-data/people');
  const users = {};
  for (const [k, email] of Object.entries({ admin: 'admin@demo.local', superadmin: 'superadmin@demo.local', agent: 'agent@demo.local', manager: 'manager@demo.local', buyer: 'buyer@demo.local', owner: 'owner@demo.local', builder: 'builder@demo.local' })) {
    users[k] = await User.findOne({ email }).select('+permissions');
    if (!users[k]) throw new Error(`${email} is missing: run "node scripts/seed-demo-users.js" first`);
  }
  const city = await Master.findOne({ type: 'city', code: 'pune' });
  if (!city) throw new Error('Pune masters are missing: run "npm run seed" first');
  const localities = {};
  for (const m of await Master.find({ type: 'locality', parentId: city._id, active: true, 'meta.centroid': { $ne: null } })) localities[m.code] = { _id: m._id, name: m.name, centroid: m.meta.centroid.coordinates };
  return { users, cityId: city._id, localities, passwordHash: await bcrypt.hash(people.demoPassword(), 10) };
}

async function seedSettings(ctx) {
  const adminUsers = require('../src/modules/auth/services/admin-users.service');
  const want = {
    'verification.siteVisitEnabled': true, // site verification visits (Could) switched on for the demo
    'partners.loanReferralEnabled': true,
    'partners.rentalAgreementEnabled': true,
    'company.gstin': '27AABCP4321Q1Z8', // shown on tax invoices
  };
  const all = await settings.all();
  const changes = Object.entries(want).filter(([k, v]) => JSON.stringify(all[k]) !== JSON.stringify(v)).map(([key, value]) => ({ key, value }));
  if (!changes.length) return 'skip';
  await adminUsers.patchSettings(ctx.users.superadmin, { changes }, fakeReq(ctx.users.superadmin));
  settings.clearCache();
  return true;
}

// Counters must be ahead of numbers already in the database (an older run or a
// test may have created RE26-000002 while the counter still says 1).
async function syncCounters() {
  const { Counter } = require('../src/core/counters');
  const m = (p) => require(p);
  const pairs = [
    ['listing', m('../src/modules/listings/models').Property, 'listingNo'], ['project', m('../src/modules/projects/models').Project, 'projectNo'],
    ['lead', m('../src/modules/leads/models').Lead, 'leadNo'], ['deal', m('../src/modules/deals/models').Deal, 'dealNo'],
    ['sitevisit', m('../src/modules/leads/models').SiteVisit, 'visitNo'], ['offer', m('../src/modules/leads/models').Offer, 'offerNo'],
    ['agreement', m('../src/modules/approvals/models').Agreement, 'agreementNo'], ['verificationvisit', m('../src/modules/approvals/models').VerificationVisit, 'visitNo'],
    ['verification', m('../src/modules/listings/models').VerificationSession, 'sessionNo'], ['soldelsewhere', m('../src/modules/listings/models').SoldElsewhereCheck, 'checkNo'],
    ['brokerflag', m('../src/modules/kyc/models').BrokerFlag, 'flagNo'], ['seekerflag', m('../src/modules/kyc/models').SeekerFlag, 'flagNo'],
    ['listingreport', m('../src/modules/search/models').ListingReport, 'reportNo'],
  ];
  const yy = String(new Date().getFullYear()).slice(2);
  let fixed = 0;
  for (const [key, Model, field] of pairs) {
    const rows = await Model.find({ [field]: new RegExp(`^[A-Z]+${yy}-\\d+$`) }).select(field).lean();
    const max = rows.reduce((a, r) => Math.max(a, Number(String(r[field]).split('-').pop())), 0);
    const c = await Counter.findById(key).lean();
    if (max > ((c && c.seq) || 0)) { await Counter.updateOne({ _id: key }, { $max: { seq: max } }, { upsert: true }); fixed += 1; }
  }
  return fixed ? true : 'skip';
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  log(`Demo seed -> ${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`);
  require('../src/jobs').registerAll(); // event listeners (MLM outbox etc.); the job worker itself is NOT started here
  const people = require('./demo-data/people');
  const projects = require('./demo-data/projects');
  const listings = require('./demo-data/listings');
  const ctx = await context();

  log('1/9 settings'); await step('counters ahead of existing numbers', syncCounters); await step('settings overrides', () => seedSettings(ctx));
  log('2/9 accounts'); await people.seedListers(ctx); await people.seedBrands(ctx); await people.seedStaff(ctx); await people.seedSecurity(ctx); await people.seedFlags(ctx);
  log('3/9 projects'); await projects.seedProjects(ctx);
  log('4/9 listings'); await listings.seedListings(ctx);
  const lifecycle = require('./demo-data/lifecycle');
  const leads = require('./demo-data/leads');
  const finance = require('./demo-data/finance');
  const misc = require('./demo-data/misc');
  log('5/9 verification, reports, views, shortlists, saved searches, trends'); await lifecycle.seedVerification(ctx); await lifecycle.seedSearch(ctx);
  log('6/9 leads'); await leads.seedLeads(ctx);
  log('7/9 deals, receivables, partners, outbox'); await finance.seedFinance(ctx);
  log('8/9 listing lifecycle, masters'); await listings.reloadListings(ctx); await lifecycle.seedLifecycle(ctx); await lifecycle.seedLifecycle2(ctx); await lifecycle.seedMasters(ctx);
  log('9/9 CMS, agreements, availability, reports, account events, notifications');
  await misc.seedCms(ctx); await misc.seedAgreements(ctx); await misc.seedAvailability(ctx); await misc.seedReports(ctx); await misc.seedMore(ctx);
  await people.rejectOwner4(ctx); await people.banBroker(ctx);
  await misc.seedNotifications(ctx); await misc.spreadTimelines(ctx);

  log(`\nDone: ${stats.ok} steps ran (created, or checked against their target state), ${stats.skipped} skipped as already done, ${stats.failed} failed.`);
  if (stats.failed) { log('Failures:'); stats.errors.forEach((e) => log(`  - ${e}`)); }
  await mongoose.disconnect();
  process.exit(stats.failed ? 2 : 0);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
