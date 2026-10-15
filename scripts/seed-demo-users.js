// Development-only demo accounts, one per role, for clicking through the
// panels locally. Refuses to run in production. All share one test password.
//   node scripts/seed-demo-users.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const env = require('../src/config/env');
const { User } = require('../src/modules/auth/models');
const { MANAGER_DEFAULTS } = require('../src/constants/permissions');

const DEMO_PASSWORD = 'Demo@12345';
const ACCOUNTS = [
  { role: 'buyer', name: 'Demo Buyer', email: 'buyer@demo.local', phone: '+919811000001' },
  { role: 'lister', listerType: 'owner', name: 'Demo Owner', email: 'owner@demo.local', phone: '+919811000002', kyc: { status: 'not_started' } },
  { role: 'lister', listerType: 'builder', name: 'Demo Builder', email: 'builder@demo.local', phone: '+919811000003', kyc: { status: 'verified', legalName: 'Demo Builder' }, brand: { name: 'Skyline Homes', approved: true } },
  { role: 'agent', name: 'Demo Agent', email: 'agent@demo.local', phone: '+919811000004', permissions: [] },
  { role: 'manager', name: 'Demo Manager', email: 'manager@demo.local', phone: '+919811000005', permissions: MANAGER_DEFAULTS || [] },
  { role: 'superadmin', name: 'Demo Super Admin', email: 'superadmin@demo.local', phone: '+919811000007', permissions: [] },
  { role: 'admin', name: 'Demo Admin', email: 'admin@demo.local', phone: '+919811000006', permissions: ['dashboard.view', 'listers.verify', 'properties.approve', 'agreements.view', 'masters.manage'] },
];

(async () => {
  if (env.isProd) throw new Error('Demo users must never be created in production');
  await mongoose.connect(env.MONGO_URI);
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const a of ACCOUNTS) {
    await User.updateOne({ email: a.email }, {
      $set: { ...a, passwordHash, status: 'active', emailVerified: true, phoneVerified: true, failedLogins: 0, mustChangePassword: false },
      $unset: { lockedUntil: 1 },
    }, { upsert: true });
    console.log(`${a.role.padEnd(8)} ${a.email}`);
  }
  console.log(`password for all: ${DEMO_PASSWORD}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
