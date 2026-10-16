// Demo accounts: extra listers (KYC in every status), a second builder with a
// brand + logo, more agents / a second manager / a finance admin, buyers, teams,
// routing rules, 2FA, blocklist and broker flags. Accounts are matched by email.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { User, LoginHistory } = require('../../src/modules/auth/models');
const { Team, RoutingRule } = require('../../src/modules/teams/models');
const { BrokerFlag } = require('../../src/modules/kyc/models');
const kyc = require('../../src/modules/kyc/service');
const brand = require('../../src/modules/kyc/brand.service');
const teams = require('../../src/modules/teams/service');
const authSvc = require('../../src/modules/auth/services/auth.service');
const account = require('../../src/modules/auth/services/account.service');
const adminUsers = require('../../src/modules/auth/services/admin-users.service');
const staffSvc = require('../../src/modules/auth/services/staff.service');
const { securityEvent } = require('../../src/core/audit');
const media = require('./media');
const { fakeReq, step, log, loadUser, daysAgo, daysAhead, col } = require('./context');

// The shared demo password lives in scripts/seed-demo-users.js; read it, never print it.
function demoPassword() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'seed-demo-users.js'), 'utf8');
  const m = /DEMO_PASSWORD\s*=\s*'([^']+)'/.exec(src);
  if (!m) throw new Error('Could not read DEMO_PASSWORD from scripts/seed-demo-users.js');
  return m[1];
}

const LISTERS = [
  { email: 'landlord@demo.local', name: 'Rohan Kulkarni', phone: '+919822000101', listerType: 'landlord', kycTarget: 'verified', pan: 'BKRPK4521L', dob: '1984-03-12', city: 'Pune', billing: { name: 'Rohan Kulkarni', address: 'Flat 12, Shanti Kunj, Kharadi, Pune 411014', state: 'Maharashtra' } },
  { email: 'owner2@demo.local', name: 'Sneha Patil', phone: '+919822000102', listerType: 'owner', kycTarget: 'verified', pan: 'CSNPP7781M', dob: '1990-07-25', city: 'Bengaluru', billing: { name: 'Sneha Patil', address: '44 Indiranagar 2nd Stage, Bengaluru 560038', state: 'Karnataka' } },
  { email: 'owner3@demo.local', name: 'Amit Joshi', phone: '+919822000103', listerType: 'owner', kycTarget: 'submitted', pan: 'DAJPJ1290Q', dob: '1979-11-02', city: 'Pune' },
  { email: 'landlord2@demo.local', name: 'Meera Iyer', phone: '+919822000104', listerType: 'landlord', kycTarget: 'resubmission_required', pan: 'EMIPI3345K', dob: '1987-01-19', city: 'Pune' },
  { email: 'landlord3@demo.local', name: 'Pooja Kale', phone: '+919822000105', listerType: 'landlord', kycTarget: 'under_review', pan: 'FPKPK8812D', dob: '1992-05-30', city: 'Pune' },
  { email: 'owner4@demo.local', name: 'Vikram Shinde', phone: '+919822000106', listerType: 'owner', kycTarget: 'verified', pan: 'GVSPS5567H', dob: '1975-09-09', city: 'Pune' }, // rejected later (listings suspended)
  { email: 'owner5@demo.local', name: 'Sanjay Pawar', phone: '+919822000107', listerType: 'owner', kycTarget: 'verified', pan: 'HSPPP2234B', dob: '1982-12-14', city: 'Pune', listingLimit: 2, billing: { name: 'Sanjay Pawar', address: 'Survey 21, Wakad, Pune 411057', state: 'Maharashtra' } },
  { email: 'broker.suspect@demo.local', name: 'Deepak More', phone: '+919822000108', listerType: 'owner', kycTarget: 'verified', pan: 'JDMPM9901C', dob: '1988-04-04', city: 'Pune' }, // banned later
  // Same PAN as owner5 and a legal name that does not match: KYC auto-checks (name_mismatch, pan_reused) and broker rule R4.
  { email: 'landlord4@demo.local', name: 'Ganesh Pawar', phone: '+919822000110', listerType: 'landlord', kycTarget: 'resubmission_required', pan: 'HSPPP2234B', legalName: 'Ganesh R Pawar Enterprises', dob: '1980-08-18', city: 'Pune', referredByEmail: 'owner2@demo.local' },
  {
    email: 'builder2@demo.local', name: 'Anil Mehta', phone: '+919822000109', listerType: 'builder', kycTarget: 'verified', pan: 'AAKCR1234E', dob: '1970-02-20', city: 'Pune',
    company: { name: 'Riverstone Developers Pvt Ltd', type: 'private_limited', cin: 'U45200PN2011PTC139876', gstin: '27AAKCR1234E1Z5', rera: 'A51700012345' },
    billing: { name: 'Riverstone Developers Pvt Ltd', gstin: '27AAKCR1234E1Z5', address: 'Riverstone House, Baner Road, Pune 411045', state: 'Maharashtra' },
  },
];

const STAFF = [
  { email: 'agent2@demo.local', name: 'Priya Nair', phone: '+919822000201', role: 'agent', extra: ['verification.field'], team: 'Pune Sales' },
  { email: 'agent3@demo.local', name: 'Karan Malhotra', phone: '+919822000202', role: 'agent', extra: [], team: 'Pune East Sales' },
  { email: 'manager2@demo.local', name: 'Kavita Deshmukh', phone: '+919822000203', role: 'manager', extra: ['contacts.view', 'leads.export'], team: 'Pune East Sales' },
  {
    email: 'finance@demo.local', name: 'Neha Gupta', phone: '+919822000204', role: 'admin',
    extra: ['dashboard.view', 'deals.verify', 'receivables.manage', 'invoices.issue', 'reports.view', 'partners.manage', 'verification.review', 'verification.schedule', 'properties.manage', 'users.manage', 'logs.view', 'agreements.manage'],
  },
];

const BUYERS = [
  { email: 'buyer2@demo.local', name: 'Arjun Rao', phone: '+919833000102', referredByEmail: 'owner2@demo.local' },
  { email: 'buyer3@demo.local', name: 'Fatima Shaikh', phone: '+919833000103', locale: 'hi', notificationPrefs: { marketing: { email: false, sms: false }, leads: { sms: true } } },
  { email: 'buyer4@demo.local', name: 'Rahul Verma', phone: '+919833000104' }, // blocked
  { email: 'buyer5@demo.local', name: 'Ishaan Kapoor', phone: '+919833000105' }, // deletion request completed -> anonymised
];

async function ensureUser(base, passwordHash, invitedBy) {
  let u = await User.findOne({ email: base.email });
  if (u) return { user: u, created: false };
  u = await User.create({
    name: base.name, email: base.email, phone: base.phone, role: base.role, listerType: base.listerType, passwordHash,
    status: 'active', emailVerified: true, phoneVerified: true, referralCode: await authSvc.uniqueReferralCode(),
    ...(base.role !== 'buyer' && base.role !== 'lister' ? { invitedBy } : {}),
    ...(base.extraFields || {}),
  });
  return { user: u, created: true };
}

// ---------------------------------------------------------------- KYC through the real service

const DOCS = {
  owner: ['id_proof', 'pan_card', 'address_proof'],
  landlord: ['id_proof', 'pan_card', 'address_proof'],
  builder: ['incorporation_certificate', 'signatory_id', 'authorisation_letter', 'rera_registration', 'company_pan'],
};

async function kycToSubmitted(u, spec) {
  const req = fakeReq(u);
  await kyc.saveForm(u, {
    legalName: spec.legalName || spec.name, dob: spec.dob, pan: spec.pan, aadhaarLast4: spec.pan.slice(5, 9),
    address: { line1: (spec.billing && spec.billing.address) || `House 7, Lane 3, ${spec.city}`, line2: 'Near Ganesh Temple', city: spec.city, state: (spec.billing && spec.billing.state) || 'Maharashtra', pincode: spec.city === 'Bengaluru' ? '560038' : '411045' },
    ...(spec.company ? { company: spec.company } : {}),
  }, req);
  for (const docType of DOCS[u.listerType]) {
    const f = await media.uploadPdf(u._id, 'kyc_doc', `${docType.replace(/_/g, ' ')} - ${spec.name}`, ['KYC document (demo)'], `${spec.email}:${docType}`);
    await kyc.addDocument(u, { docType, fileId: String(f._id) }, req);
  }
  // A slightly different typed name on one account exercises the name-mismatch auto-check.
  const typedName = spec.email === 'landlord3@demo.local' ? 'P. Kale' : spec.name;
  await kyc.submit(u, { statements: [true, true, true, true], typedName }, req);
}

async function kycDecide(u, admin, decision, extra = {}) {
  const req = fakeReq(admin);
  await kyc.claim(String(u._id), req);
  if (decision === 'claim') return;
  const full = await User.findById(u._id);
  // KYC documents are stored without _id (app bug, see docs/DEMO_DATA.md), so every per-document decision lands on
  // the first document. Verify: all marked accepted (only the first one sticks); otherwise only the first is rejected with a comment.
  const list = full.kyc.documents || [];
  const docs = decision === 'verify' ? list.map((d) => ({ docId: String(d._id), status: 'accepted' })) : list.slice(0, 1).map((d) => ({ docId: String(d._id), status: 'rejected', comment: 'Photo is blurred, upload a clear scan' }));
  await kyc.decide(String(u._id), { decision, documents: docs, ...extra }, req);
}

async function seedListers(ctx) {
  const admin = ctx.users.admin;
  for (const spec of LISTERS) {
    await step(`lister ${spec.email}`, async () => {
      const ref = spec.referredByEmail ? await User.findOne({ email: spec.referredByEmail }).select('referralCode') : null;
      const { user } = await ensureUser({ ...spec, role: 'lister', extraFields: { locale: 'en', ...(ref ? { referredBy: ref.referralCode, referralCapturedAt: daysAgo(20) } : {}) } }, ctx.passwordHash);
      let u = await User.findById(user._id);
      ctx.users[spec.email] = u;
      if (spec.billing && !(u.billing && u.billing.name)) await account.updateMe(u, { billing: spec.billing });
      if (u.kyc && u.kyc.status && u.kyc.status !== 'not_started') return 'skip';
      await kycToSubmitted(u, spec);
      u = await User.findById(u._id);
      if (spec.kycTarget === 'verified') await kycDecide(u, admin, 'verify', { comment: 'All documents match' });
      else if (spec.kycTarget === 'under_review') await kycDecide(u, admin, 'claim');
      else if (spec.kycTarget === 'resubmission_required') await kycDecide(u, admin, 'resubmit', { comment: 'The ID proof scan is unreadable. Please upload a clear copy.' });
      if (spec.listingLimit) await kyc.setListingLimit(String(u._id), { listingLimit: spec.listingLimit }, fakeReq(admin));
      return true;
    });
  }
  await step('landlord3 KYC claim (re-claimed when the 30-minute lock lapsed)', async () => {
    const u = await User.findOne({ email: 'landlord3@demo.local' });
    if (!u || u.kyc.status !== 'under_review' || (u.kyc.claim && u.kyc.claim.until > new Date())) return 'skip';
    await kyc.claim(String(u._id), fakeReq(admin));
    return true;
  });
  for (const k of Object.keys(ctx.users)) if (k.includes('@')) ctx.users[k] = await User.findById(ctx.users[k]._id).select('+permissions');
}

// ---------------------------------------------------------------- builder brands

async function seedBrands(ctx) {
  const admin = ctx.users.admin;
  const b2 = ctx.users['builder2@demo.local'];
  await step('brand Riverstone (approved, logo) + pending rename', async () => {
    const u = await User.findById(b2._id);
    if (u.brand && u.brand.approved && u.brand.pending && u.brand.pending.name) return 'skip';
    if (!(u.brand && u.brand.approved)) {
      const logo = await media.uploadPhoto(u._id, 'avatar', 'RIVERSTONE', 'logo:riverstone', { w: 512, h: 512, sub: 'Developers' });
      await brand.request(u, { name: 'Riverstone', logoFileId: String(logo._id) }, fakeReq(u));
      await brand.decide(String(u._id), { decision: 'approve' }, fakeReq(admin));
      // KYC company card shows the approved logo too.
      await col(User).updateOne({ _id: u._id }, { $set: { 'kyc.company.logoUrl': logo.url } });
    }
    const again = await User.findById(b2._id);
    await brand.request(again, { name: 'Riverstone Realty' }, fakeReq(again)); // waits for admin approval
    return true;
  });
  await step('brand request rejected for builder@demo.local', async () => {
    const u = await User.findOne({ email: 'builder@demo.local' });
    if (u.brand && u.brand.rejectReason) return 'skip';
    if (!(u.billing && u.billing.name)) await account.updateMe(u, { billing: { name: 'Skyline Homes LLP', gstin: '27AAFFS5678K1Z2', address: 'Skyline Plaza, Hinjewadi Phase 1, Pune 411057', state: 'Maharashtra' } });
    await brand.request(u, { name: 'Skyline Homes and Villas' }, fakeReq(u));
    await brand.decide(String(u._id), { decision: 'reject', reason: 'Brand name must match the registered firm name' }, fakeReq(admin));
    return true;
  });
  await step('billing for owner@demo.local', async () => {
    const u = await User.findOne({ email: 'owner@demo.local' });
    if (u.billing && u.billing.name) return 'skip';
    await account.updateMe(u, { billing: { name: 'Demo Owner', address: 'B-402 Park View, Baner, Pune 411045', state: 'Maharashtra' } });
    return true;
  });
}

// ---------------------------------------------------------------- staff, teams, routing

async function seedStaff(ctx) {
  const superadmin = ctx.users.superadmin;
  for (const s of STAFF) {
    await step(`staff ${s.email}`, async () => {
      const { user, created } = await ensureUser({ ...s, extraFields: { extraPermissions: s.extra, permissions: staffSvc.effectivePermissions(s.role, s.extra) } }, ctx.passwordHash, superadmin._id);
      ctx.users[s.email] = await User.findById(user._id).select('+permissions');
      return created ? true : 'skip';
    });
  }
  await step('password history on agent2', async () => {
    const u = await User.findOne({ email: 'agent2@demo.local' }).select('+passwordHistory');
    if ((u.passwordHistory || []).length) return 'skip';
    await col(User).updateOne({ _id: u._id }, { $set: { passwordHistory: [await bcrypt.hash('Old@Pass1', 10)] } });
    return true;
  });

  // Teams: Pune Sales gets agent2; a new Pune East Sales team for Kharadi / Viman Nagar.
  await step('team Pune Sales members', async () => {
    const t = await Team.findOne({ name: 'Pune Sales' });
    const agent2 = ctx.users['agent2@demo.local'];
    if (t.members.some((m) => String(m.agentId) === String(agent2._id))) return 'skip';
    const members = [...t.members.map((m) => ({ agentId: String(m.agentId), capacity: m.capacity, available: m.available })), { agentId: String(agent2._id), capacity: 40, available: true }];
    await teams.editTeam(String(t._id), { members, territories: { cities: ['Pune'], localities: ['Baner', 'Wakad', 'Hinjewadi', 'Kothrud'] } }, fakeReq(superadmin));
    return true;
  });
  await step('team Pune East Sales', async () => {
    if (await Team.exists({ name: 'Pune East Sales' })) return 'skip';
    const m2 = ctx.users['manager2@demo.local']; const a3 = ctx.users['agent3@demo.local'];
    const t = await teams.createTeam({
      name: 'Pune East Sales', managerIds: [String(m2._id)], members: [{ agentId: String(a3._id), capacity: 30 }, { agentId: String(m2._id), capacity: 15 }],
      territories: { cities: ['Pune'], localities: ['Kharadi', 'Viman Nagar'] }, workingHours: { start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] }, mode: 'least_open_leads',
    }, fakeReq(superadmin));
    // Karan is on leave next week (team member leave + his own availability card).
    await teams.patchMember(String(t._id), String(a3._id), { leaveFrom: daysAhead(7), leaveTo: daysAhead(10) }, superadmin, fakeReq(superadmin));
    return true;
  });
  await step('staff teamId + availability', async () => {
    for (const t of await Team.find({ name: { $in: ['Pune Sales', 'Pune East Sales'] } })) {
      const ids = [...t.members.map((m) => m.agentId), ...t.managerIds];
      await User.updateMany({ _id: { $in: ids }, teamId: null }, { $set: { teamId: t._id } });
    }
    const a3 = ctx.users['agent3@demo.local'];
    await User.updateOne({ _id: a3._id }, { $set: { availability: { away: false, leaveFrom: daysAhead(7), leaveTo: daysAhead(10) } } });
    return true;
  });
  await step('routing rules', async () => {
    const east = await Team.findOne({ name: 'Pune East Sales' });
    const west = await Team.findOne({ name: 'Pune Sales' });
    let n = 0;
    if (!(await RoutingRule.exists({ name: 'East Pune rentals' }))) {
      await teams.createRule({ name: 'East Pune rentals', priority: 4, teamId: String(east._id), modeOverride: 'least_open_leads', conditions: { cities: ['Pune'], localities: ['Kharadi', 'Viman Nagar'], purpose: 'rent', sources: ['enquiry', 'callback', 'site_visit', 'whatsapp'] } }, fakeReq(superadmin));
      n += 1;
    }
    if (!(await RoutingRule.exists({ name: 'Commercial and land, owner and builder' }))) {
      await teams.createRule({ name: 'Commercial and land, owner and builder', priority: 6, teamId: String(west._id), conditions: { cities: ['Pune'], category: 'commercial', types: ['office', 'shop'], budgetMin: 10000, budgetMax: 100000000, listerTypes: ['owner', 'landlord', 'builder'] } }, fakeReq(superadmin));
      n += 1;
    }
    if (!(await RoutingRule.exists({ name: 'Paused: premium villas (old rule)' }))) {
      await teams.createRule({ name: 'Paused: premium villas (old rule)', priority: 90, active: false, teamId: String(west._id), conditions: { cities: ['Pune'], types: ['villa'], budgetMin: 30000000 } }, fakeReq(superadmin));
      n += 1;
    }
    return n ? true : 'skip';
  });
}

// ---------------------------------------------------------------- 2FA, buyers, account states

async function seedSecurity(ctx) {
  await step('2FA (authenticator) for manager2', async () => {
    const m2 = await User.findOne({ email: 'manager2@demo.local' });
    if (m2.twoFactor && m2.twoFactor.method === 'totp') return 'skip';
    const setup = await authSvc.totpSetup(m2);
    await authSvc.totpEnable(m2, { code: authenticator.generate(setup.secret) }, fakeReq(m2)); // recovery codes are discarded, never printed
    return true;
  });
  await step('2FA by SMS for landlord', async () => {
    const u = await User.findOne({ email: 'landlord@demo.local' });
    if (u.twoFactor && u.twoFactor.method === 'sms') return 'skip';
    await authSvc.setOtpMethod(u._id, 'sms', fakeReq(u));
    return true;
  });
  for (const b of BUYERS) {
    await step(`buyer ${b.email}`, async () => {
      // buyer5 is anonymised by the deletion flow below (email replaced), so its deletion request is the key.
      const { DeletionRequest } = require('../../src/modules/auth/models');
      if (b.email === 'buyer5@demo.local' && await DeletionRequest.exists({ reason: 'Moving abroad, please delete my data (demo)' })) return 'skip';
      const ref = b.referredByEmail ? await User.findOne({ email: b.referredByEmail }).select('referralCode') : null;
      const { user, created } = await ensureUser({
        ...b, role: 'buyer',
        extraFields: { locale: b.locale || 'en', notificationPrefs: b.notificationPrefs || {}, ...(ref ? { referredBy: ref.referralCode, referralCapturedAt: daysAgo(12) } : {}) },
      }, ctx.passwordHash);
      ctx.users[b.email] = user;
      return created ? true : 'skip';
    });
  }
  await step('buyer4 blocked', async () => {
    const u = await User.findOne({ email: 'buyer4@demo.local' });
    if (u.status === 'blocked') return 'skip';
    await adminUsers.setStatus(String(u._id), { status: 'blocked', reason: 'Repeated fake enquiries reported by agents' }, fakeReq(ctx.users.superadmin));
    await User.updateOne({ _id: u._id }, { $set: { blockedReason: 'Repeated fake enquiries reported by agents' } });
    return true;
  });
  await step('buyer3 old lock + failed logins', async () => {
    const u = await User.findOne({ email: 'buyer3@demo.local' });
    if (await LoginHistory.exists({ userId: u._id, success: false })) return 'skip';
    await User.updateOne({ _id: u._id }, { $set: { lockedUntil: daysAgo(3), lastLoginAt: daysAgo(1) } });
    await LoginHistory.insertMany([
      { userId: u._id, success: false, method: 'password', ip: '49.36.12.8', ua: 'Mozilla/5.0 (Android 14)', reason: 'bad_password', at: daysAgo(3) },
      { userId: u._id, success: false, method: 'password', ip: '49.36.12.8', ua: 'Mozilla/5.0 (Android 14)', reason: 'locked', at: daysAgo(3) },
      { userId: u._id, success: true, method: 'otp_email', ip: '49.36.12.8', ua: 'Mozilla/5.0 (Android 14)', at: daysAgo(1) },
    ]);
    await securityEvent(fakeReq(null, { ip: '49.36.12.8' }), 'account.locked', { userId: u._id, meta: { failedLogins: 5, minutes: 15 } });
    return true;
  });
  await step('deletion requests (pending + completed)', async () => {
    const { DeletionRequest } = require('../../src/modules/auth/models');
    let n = 0;
    const b3 = await User.findOne({ email: 'buyer3@demo.local' });
    if (!(await DeletionRequest.exists({ userId: b3._id }))) { await account.requestDeletion(b3, { reason: 'I have bought a flat and no longer need the account' }, fakeReq(b3)); n += 1; }
    const done = await DeletionRequest.findOne({ reason: 'Moving abroad, please delete my data (demo)' });
    if (!done) {
      const b5 = await User.findOne({ email: 'buyer5@demo.local' });
      if (b5) {
        const r = await account.requestDeletion(b5, { reason: 'Moving abroad, please delete my data (demo)' }, fakeReq(b5));
        await adminUsers.decideDeletion(String(r._id), { status: 'completed', note: 'Identity confirmed on call; data anonymised' }, fakeReq(ctx.users.superadmin));
        n += 1;
      }
    }
    return n ? true : 'skip';
  });
}

// ---------------------------------------------------------------- broker flags, ban, blocklist

async function seedFlags(ctx) {
  const admin = ctx.users.superadmin;
  await step('broker flags (manual open + resolved warned)', async () => {
    const owner5 = await User.findOne({ email: 'owner5@demo.local' });
    const deepak = await User.findOne({ email: 'broker.suspect@demo.local' });
    let n = 0;
    if (!(await BrokerFlag.exists({ listerId: owner5._id, rule: 'manual' }))) {
      const f = await kyc.manualFlag({ listerId: String(owner5._id), note: 'Buyer said a different person showed the flat and asked for brokerage' }, fakeReq(admin));
      await kyc.resolveFlag(String(f._id), { resolution: 'confirm_warn', note: 'Warned the lister by email; first instance' }, fakeReq(admin));
      n += 1;
    }
    if (!(await BrokerFlag.exists({ listerId: deepak._id }))) {
      await kyc.manualFlag({ listerId: String(deepak._id), note: 'Same photos and phone pattern seen on a broker website' }, fakeReq(admin));
      n += 1;
    }
    return n ? true : 'skip';
  });
}

// Banning Deepak happens after his listing exists (listings get suspended, identifiers blocklisted).
async function banBroker(ctx) {
  await step('ban broker.suspect (blocklist)', async () => {
    const deepak = await User.findOne({ email: 'broker.suspect@demo.local' });
    if (deepak.kyc.status === 'banned') return 'skip';
    const f = await BrokerFlag.findOne({ listerId: deepak._id, status: 'open' });
    if (f) await kyc.resolveFlag(String(f._id), { resolution: 'confirm_ban', note: 'Confirmed broker activity after a mystery-shopper call' }, fakeReq(ctx.users.superadmin));
    else await kyc.setListerStatus(String(deepak._id), { action: 'ban', reason: 'Confirmed broker activity' }, fakeReq(ctx.users.superadmin));
    return true;
  });
}

// Owner4 changes his KYC details after listing -> re-review -> rejected: his live listing is suspended.
async function rejectOwner4(ctx) {
  await step('owner4 KYC re-review rejected (listing suspended)', async () => {
    const u = await User.findOne({ email: 'owner4@demo.local' });
    if (u.kyc.status === 'rejected') return 'skip';
    const spec = LISTERS.find((l) => l.email === 'owner4@demo.local');
    if (u.kyc.status === 'verified') {
      await kyc.saveForm(u, { legalName: 'Vikram R Shinde', dob: spec.dob, pan: spec.pan, address: { line1: 'Plot 9, Paud Road, Kothrud', city: 'Pune', state: 'Maharashtra', pincode: '411038' } }, fakeReq(u));
    }
    const fresh = await User.findById(u._id);
    await kycDecide(fresh, ctx.users.admin, 'reject', { reason: 'PAN name does not match the ownership documents' });
    return true;
  });
}

module.exports = { demoPassword, seedListers, seedBrands, seedStaff, seedSecurity, seedFlags, banBroker, rejectOwner4, LISTERS };
