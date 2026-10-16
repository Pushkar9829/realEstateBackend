// Listing lifecycle after approval: photo verification sessions, site
// verification visits, "still available?" checks, pause / expiry / revision,
// sold elsewhere, reports, views, shortlists, saved searches, trends and the
// locality request queue. Everything is guarded so reruns add nothing.
const { Property, ListingCheck, SoldElsewhereCheck, VerificationSession } = require('../../src/modules/listings/models');
const { VerificationVisit } = require('../../src/modules/approvals/models');
const { User } = require('../../src/modules/auth/models');
const { Master } = require('../../src/modules/cms/models');
const { Shortlist, SavedSearch, PropertyView, ListingReport, LocalityTrend } = require('../../src/modules/search/models');
const listings = require('../../src/modules/listings/service');
const verification = require('../../src/modules/listings/verification.service');
const siteVisits = require('../../src/modules/approvals/site-visits.service');
const search = require('../../src/modules/search/service');
const cms = require('../../src/modules/cms/service');
const { notifyUser } = require('../../src/modules/notifications/service');
const media = require('./media');
const { fakeReq, step, col, istAt, daysAgo, daysAhead, HOUR } = require('./context');

const u = (email) => User.findOne({ email }).select('+permissions');
const L = (ctx, k) => ctx.listings[k];

// ---------------------------------------------------------------- photo verification (RE-A-20)

async function photoSession(ctx, key, outcome) {
  const p = L(ctx, key);
  if (!p || await VerificationSession.exists({ propertyId: p._id })) return 'skip';
  const lister = await User.findById(p.listerId);
  const s = await verification.start(lister, String(p._id), fakeReq(lister));
  if (outcome === 'open') return true;
  const [lng, lat] = p.location.geo.coordinates;
  await verification.submitLocation(s.token, { lat: lat + 0.0002, lng: lng + 0.0001, accuracy: 12 });
  for (let i = 0; i < 4; i += 1) {
    const label = ['Main door', 'Living room', 'Kitchen', 'Window view'][i];
    const buf = await media.photo(label, `${key}:live:${i}`, { w: 1024, h: 768, sub: 'Live capture', category: media.categoryFor({ type: p.type, category: p.category, label }) });
    await verification.uploadPhoto(s.token, { buffer: buf, originalname: `live-${i}.jpg`, mimetype: 'image/jpeg', size: buf.length }, { lat: lat + 0.0002, lng: lng + 0.0001, accuracy: 15, capturedAt: new Date() });
  }
  await verification.submit(s.token, { addToGallery: outcome === 'approve_gallery' });
  if (outcome === 'pending') return true;
  const qa = ctx.users['finance@demo.local'];
  const session = await VerificationSession.findOne({ propertyId: p._id, status: 'pending_review' });
  await verification.claim(String(session._id), fakeReq(qa));
  if (outcome === 'reject') await verification.decide(String(session._id), { decision: 'reject', reason: 'poor_quality', comment: 'Photos are too dark to compare with the listing photos' }, fakeReq(qa));
  else await verification.decide(String(session._id), { decision: 'approve' }, fakeReq(qa));
  return true;
}

// ---------------------------------------------------------------- site verification visits (RE-D-13)

async function verificationPhotos(agent, key, n = 4) {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(String((await media.uploadPhoto(agent._id, 'verification_photo', ['Gate', 'Hall', 'Bedroom', 'Kitchen'][i % 4], `${key}:vv:${i}`, { w: 1024, h: 768, sub: 'Field visit', category: ['apartment_ext', 'living', 'bedroom', 'kitchen'][i % 4] }))._id));
  return ids;
}

async function siteVisit(ctx, key, kind) {
  const p = L(ctx, key);
  if (!p || await VerificationVisit.exists({ propertyId: p._id })) return 'skip';
  const lister = await User.findById(p.listerId);
  const fin = ctx.users['finance@demo.local'];
  const exec = await u('agent2@demo.local');
  const [lng, lat] = p.location.geo.coordinates;
  if (kind === 'requested' || kind === 'cancelled') {
    const v = await siteVisits.listerRequest(lister, String(p._id), { note: 'Please visit on a weekday morning' }, fakeReq(lister));
    if (kind === 'cancelled') await siteVisits.cancel(lister, String(v._id), { reason: 'Tenant moving in this week, will request again later' }, fakeReq(lister), { listerId: lister._id });
    return true;
  }
  let v;
  if (kind === 'scheduled') {
    return siteVisits.schedule(fin, { propertyId: String(p._id), scheduledAt: istAt(3, 11, 0), executiveId: String(exec._id), notes: 'Owner will be present with the sale deed' }, fakeReq(fin));
  }
  const req = await siteVisits.listerRequest(lister, String(p._id), { note: 'Want the Site verified badge' }, fakeReq(lister));
  v = await siteVisits.schedule(fin, { visitId: String(req._id), scheduledAt: istAt(1, 10, 30), executiveId: String(exec._id) }, fakeReq(fin));
  // The visit "happened" this morning: move the slot into the past, then record the outcome.
  await col(VerificationVisit).updateOne({ _id: v._id }, { $set: { scheduledAt: new Date(Date.now() - 2 * HOUR) } });
  if (kind === 'verified') {
    await siteVisits.outcome(exec, String(v._id), {
      result: 'verified', checklist: Object.fromEntries(siteVisits.CHECKLIST.map((k) => [k, true])), photoFileIds: await verificationPhotos(exec, key),
      gps: { lat: lat + 0.0003, lng: lng - 0.0002, accuracy: 18 }, remarks: 'Property matches the listing; owner showed the sale deed',
    }, fakeReq(exec));
  } else if (kind === 'absent') {
    await siteVisits.outcome(exec, String(v._id), { result: 'lister_absent', gps: { lat: lat + 0.0003, lng: lng - 0.0002, accuracy: 30 }, remarks: 'Waited 30 minutes, owner unreachable' }, fakeReq(exec));
    await siteVisits.patch(fin, String(v._id), { scheduledAt: istAt(4, 15, 0), notes: 'Rescheduled once after the owner missed the first visit' }, fakeReq(fin));
  }
  return true;
}

async function seedVerification(ctx) {
  for (const [k, o] of [['o1', 'approve_gallery'], ['b5', 'approve'], ['r2', 'pending'], ['s2', 'reject'], ['r6', 'open']]) await step(`photo verification ${k} ${o}`, () => photoSession(ctx, k, o));
  for (const [k, kind] of [['o2', 'verified'], ['r1', 'requested'], ['s1', 'scheduled'], ['s3', 'absent'], ['r7', 'cancelled']]) await step(`site visit ${k} ${kind}`, () => siteVisit(ctx, k, kind));
}

// ---------------------------------------------------------------- after leads: checks, pause, expiry, revision, sold elsewhere

async function check(ctx, key, trigger, at) {
  const p = await Property.findById(L(ctx, key)._id);
  if (await ListingCheck.exists({ propertyId: p._id })) return null;
  return listings.createCheck(p, trigger, at || new Date());
}

async function seedLifecycle(ctx) {
  await step('check r7 pending', async () => ((await check(ctx, 'r7', 'day30')) ? true : 'skip'));
  await step('check r1 pending with reminder', async () => ((await check(ctx, 'r1', 'day30', daysAgo(5))) ? true : 'skip'));
  await step('check r6 answered available (SMS link)', async () => {
    const c = await check(ctx, 'r6', 'expiry7');
    if (!c) return 'skip';
    await listings.answerByToken(c.token, { answer: 'available' }, fakeReq(null));
    return true;
  });
  await step('check o3 answered pause (panel)', async () => {
    const c = await check(ctx, 'o3', 'day30');
    if (!c) return 'skip';
    const owner = await u('owner@demo.local');
    await listings.answerInPanel(owner, String(L(ctx, 'o3')._id), { answer: 'pause', reason: 'Family function at home, no visits for two weeks' }, fakeReq(owner));
    return true;
  });
  await step('check s4 unanswered -> auto-paused', async () => {
    const c = await check(ctx, 's4', 'expiry1', daysAgo(8));
    if (!c) return 'skip';
    await listings.runFreshness(); // auto-pauses s4 (reply window over) and sends the r1 reminder
    return true;
  });
  await step('check p2 sold elsewhere (open finance check)', async () => {
    const c = await check(ctx, 'p2', 'day30');
    if (!c) return 'skip';
    await listings.answerByToken(c.token, { answer: 'sold_elsewhere', saleDate: new Date(Date.now() - 60000), price: 7400000 }, fakeReq(null));
    return true;
  });
  await step('r4 rented outside -> sold-elsewhere claim', async () => {
    const p = await Property.findById(L(ctx, 'r4')._id);
    if (p.status !== 'live') return 'skip';
    const ll = await u('landlord@demo.local');
    const out = await listings.deactivate(ll, String(p._id), { reason: 'rented_outside', saleDate: new Date(Date.now() - 60000), price: 36000, note: 'Rented to a relative of a neighbour' }, fakeReq(ll));
    const fin = ctx.users['finance@demo.local'];
    await listings.decideSoldElsewhere(String(out.soldElsewhereCheck._id), { assignee: String(fin._id), status: 'claim_raised', claimAmount: 36000, note: 'Tenant visited through our agent last week; one month rent claimed as per agreement' }, fakeReq(fin));
    return true;
  });
  await step('o4 expired', async () => {
    const p = await Property.findById(L(ctx, 'o4')._id);
    if (p.status !== 'live') return 'skip';
    listings.setStatus(p, 'expired', undefined, 'Expired');
    p.expiresAt = daysAgo(1);
    await p.save();
    await notifyUser({ user: await User.findById(p.listerId), event: 'listing.expired', channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, title: p.title, propertyId: String(p._id) } });
    return true;
  });
  await step('r5 price revision waiting for review', async () => {
    const p = await Property.findById(L(ctx, 'r5')._id);
    if (p.pendingRevision && p.pendingRevision.submittedAt) return 'skip';
    const ll = await u('landlord@demo.local');
    await listings.saveStep(ll, String(p._id), 4, { monthlyRent: 175000, deposit: 1050000, maintenance: 18000, negotiable: true, allInclusive: false }, fakeReq(ll));
    await listings.submit(ll, String(p._id), fakeReq(ll));
    return true;
  });
  await step('o1 price drop on a live listing (shortlisters told)', async () => {
    const p = await Property.findById(L(ctx, 'o1')._id);
    if (p.price.amount !== 920000000 || p.status !== 'live') return 'skip';
    const owner = await u('owner@demo.local');
    await listings.saveStep(owner, String(p._id), 4, { amount: 8700000, negotiable: true }, fakeReq(owner));
    return true;
  });
}

// ---------------------------------------------------------------- reports, views, shortlists, saved searches, trends

async function seedSearch(ctx) {
  await step('listing reports', async () => {
    if (await ListingReport.exists({ details: /demo seed/ })) return 'skip';
    const buyer = await u('buyer@demo.local');
    const fin = ctx.users['finance@demo.local'];
    const rep = (k, body, user, ip) => search.reportListing(String(L(ctx, k)._id), { ...body, details: `${body.details} (demo seed)` }, { ...fakeReq(user, { ip }), user });
    await rep('s1', { reason: 'wrong_info', details: 'Floor number shown is 2 but the owner said 5 on the call' }, buyer, '10.9.0.1');
    await rep('s1', { reason: 'already_sold', details: 'Neighbour says this flat was sold last month', phone: '+919833000301' }, null, '10.9.0.2');
    await rep('s2', { reason: 'broker', details: 'A broker answered when I called the society office' }, null, '10.9.0.3');
    await rep('s2', { reason: 'broker', details: 'Asked for brokerage during the visit' }, null, '10.9.0.4');
    const dup = await rep('s6', { reason: 'duplicate', details: 'Same flat is listed twice with different prices' }, null, '10.9.0.5');
    const other = await rep('o1', { reason: 'other', details: 'Photos look old' }, null, '10.9.0.6');
    const fraud = await rep('x1', { reason: 'fraud', details: 'Asked for a token amount before any visit' }, null, '10.9.0.7');
    const r = (no) => ListingReport.findOne({ reportNo: no });
    await search.actionReport(String((await r(dup.reportNo))._id), { action: 'ask_fix', note: 'Asked the owner to keep one listing only' }, fakeReq(fin));
    await search.actionReport(String((await r(other.reportNo))._id), { action: 'dismiss', note: 'Photos verified on site this month' }, fakeReq(fin));
    await search.actionReport(String((await r(fraud.reportNo))._id), { action: 'raise_broker_flag', note: 'Token before visit is a broker pattern' }, fakeReq(fin));
    await ListingReport.updateOne({ propertyId: L(ctx, 's2')._id, status: 'open' }, { $set: { status: 'under_review' } }); // picked up by the ops team
    return true;
  });
  await step('property views', async () => {
    if (await PropertyView.exists({ propertyId: L(ctx, 'o1')._id })) return 'skip'; // views live 2 days (TTL); a later rerun adds a fresh day of views
    let n = 0;
    for (const [k, p] of Object.entries(ctx.listings)) {
      const fresh = await Property.findById(p._id).select('status');
      if (fresh.status !== 'live') continue;
      const views = 3 + (k.charCodeAt(1) % 6);
      for (let i = 0; i < views; i += 1) { await search.recordView(String(p._id), fakeReq(null, { headers: { 'x-session-id': `demo-${k}-${i}` } })); n += 1; }
    }
    return n ? true : 'skip';
  });
  await step('shortlists', async () => {
    let n = 0;
    for (const [email, keys] of [['buyer@demo.local', ['o1', 'r1', 'b1', 's5', 'o2', 'r2']], ['buyer2@demo.local', ['r2', 'b3', 'o9']], ['buyer3@demo.local', ['s1', 'b4']]]) {
      const user = await u(email);
      for (const k of keys) {
        const p = L(ctx, k);
        if (!p || await Shortlist.exists({ userId: user._id, propertyId: p._id })) continue;
        const live = await Property.exists({ _id: p._id, status: 'live' });
        if (live) { await search.addShortlist(user, { propertyId: String(p._id) }); n += 1; }
      }
    }
    return n ? true : 'skip';
  });
  await step('saved searches', async () => {
    const buyer = await u('buyer@demo.local');
    if (await SavedSearch.exists({ userId: buyer._id, name: '2 BHK in Wakad under 1 Cr' })) return 'skip';
    const s1 = await search.createSaved(buyer, { name: '2 BHK in Wakad under 1 Cr', filters: { purpose: 'sale', city: 'pune', localities: 'wakad', bhk: '2', maxPrice: 10000000 }, frequency: 'instant', channels: ['email', 'in_app'] });
    await search.createSaved(buyer, { name: 'Rentals in Kharadi and Viman Nagar', filters: { purpose: 'rent', city: 'pune', localities: 'kharadi,viman-nagar', maxPrice: 40000 }, frequency: 'daily' });
    await search.createSaved(buyer, { name: 'Offices in Hinjewadi', filters: { purpose: 'rent', city: 'pune', category: 'commercial', types: 'office', localities: 'hinjewadi' }, frequency: 'weekly', channels: ['email'] });
    const b2 = await u('buyer2@demo.local');
    await search.createSaved(b2, { name: 'Villas in Baner', filters: { purpose: 'sale', city: 'pune', types: 'villa', localities: 'baner' }, frequency: 'off', channels: ['in_app'] });
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    await SavedSearch.updateOne({ _id: s1._id }, { $set: { lastAlertAt: new Date(Date.now() - 3 * HOUR), alertsToday: { count: 2, day: today }, matchCountSinceVisit: 3 } });
    return true;
  });
  await step('locality trends (6 months x every locality)', async () => {
    await search.computeTrends();
    const base = { baner: [1150000, 3800], wakad: [880000, 2900], kharadi: [1020000, 3600], hinjewadi: [780000, 2700], kothrud: [1300000, 3900], 'viman-nagar': [1250000, 4100] };
    let n = 0;
    const locs = await Master.find({ type: 'locality', code: { $in: Object.keys(base) } }).lean();
    for (const l of locs) {
      for (let m = 1; m <= 6; m += 1) {
        const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m);
        const month = d.toISOString().slice(0, 7);
        for (const [purpose, i] of [['sale', 0], ['rent', 1]]) {
          const drift = 1 - m * 0.008 + ((l.code.length + m) % 3) * 0.004;
          const avg = Math.round(base[l.code][i] * drift);
          const pts = 4 + ((l.code.length * m) % 9);
          const r = await LocalityTrend.updateOne({ localityId: l._id, purpose, category: 'residential', month }, { $setOnInsert: { cityId: l.parentId, avgPerSqft: avg, medianPerSqft: Math.round(avg * 0.97), dataPoints: pts, sources: { listings: pts - 1, deals: 1 }, published: pts >= 5 } }, { upsert: true });
          n += r.upsertedCount;
        }
      }
    }
    return n ? true : 'skip';
  });
}

// ---------------------------------------------------------------- masters: locality requests, new master rows

async function draftWithLocality(email, title, locality) {
  const lister = await u(email);
  let p = await Property.findOne({ listerId: lister._id, title });
  if (p) return p;
  const req = fakeReq(lister);
  p = await listings.createDraft(lister, { ...req, body: {} });
  await listings.saveStep(lister, String(p._id), 1, { purpose: 'rent', category: 'residential', type: 'apartment', title, description: 'Compact home close to the main road with good light and ventilation. Shops, schools and bus stops are a short walk away.' }, req);
  const city = await Master.findOne({ type: 'city', code: 'pune' });
  await listings.saveStep(lister, String(p._id), 2, { cityId: String(city._id), localityRequest: locality, addressLine: `${locality} main road, Pune`, pincode: '411045', lat: 18.5642, lng: 73.7769, landmarks: [] }, req);
  return Property.findById(p._id);
}

async function seedMasters(ctx) {
  const sa = ctx.users.superadmin;
  await step('locality request approved (Balewadi)', async () => {
    const m = await Master.findOne({ type: 'locality', name: 'Balewadi', 'request.status': { $ne: null } });
    if (m && m.request.status === 'approved') return 'skip';
    await draftWithLocality('landlord2@demo.local', 'Studio for rent in Balewadi (draft)', 'Balewadi');
    const req = await Master.findOne({ type: 'locality', name: 'Balewadi', 'request.status': 'pending' });
    await cms.decideLocalityRequest(String(req._id), { decision: 'approve', reason: 'Valid locality next to Baner' }, fakeReq(sa));
    await cms.editMaster('localities', String(req._id), { lat: 18.5763, lng: 73.7787, pincodes: ['411045'], aliases: ['Balewadi Phata'] }, fakeReq(sa));
    return true;
  });
  await step('locality request pending (Pashan)', async () => {
    if (await Master.exists({ type: 'locality', name: 'Pashan' })) return 'skip';
    await draftWithLocality('owner3@demo.local', '1 BHK for rent in Pashan (draft)', 'Pashan');
    return true;
  });
  await step('locality request rejected + merged (Baner Gaon)', async () => {
    if (await Master.exists({ type: 'locality', name: 'Baner Gaon', mergedInto: { $ne: null } })) return 'skip';
    await draftWithLocality('landlord3@demo.local', '2 BHK for rent in Baner Gaon (draft)', 'Baner Gaon');
    const req = await Master.findOne({ type: 'locality', name: 'Baner Gaon', 'request.status': 'pending' });
    await cms.decideLocalityRequest(String(req._id), { decision: 'reject', reason: 'Part of Baner; the listing was moved to Baner' }, fakeReq(sa));
    const baner = await Master.findOne({ type: 'locality', code: 'baner' });
    await cms.mergeLocality(String(req._id), { intoId: String(baner._id) }, fakeReq(sa));
    return true;
  });
  await step('new master rows (penthouse, EV charging, lost reasons)', async () => {
    let n = 0;
    if (!(await Master.exists({ type: 'property_type', code: 'penthouse' }))) {
      await cms.createMaster('property-types', { name: 'Penthouse', code: 'penthouse', category: 'residential', icon: 'building', fieldProfile: { extraFields: [{ key: 'terraceAreaSqft', label: 'Terrace area (sq ft)', type: 'number' }] } }, fakeReq(sa)); n += 1;
    }
    if (!(await Master.exists({ type: 'amenity', code: 'ev_charging' }))) {
      await cms.createMaster('amenities', { name: 'EV charging', code: 'ev_charging', group: 'Convenience', icon: 'plug' }, fakeReq(sa)); n += 1;
    }
    for (const [code, name] of [['budget_mismatch', 'Budget mismatch'], ['bought_elsewhere', 'Bought elsewhere'], ['not_responding', 'Not responding']]) {
      if (!(await Master.exists({ type: 'reason', code }))) { await cms.createMaster('reasons', { name, code, group: 'lead_lost', appliesTo: ['lead'] }, fakeReq(sa)); n += 1; }
    }
    return n ? true : 'skip';
  });
}

async function seedLifecycle2(ctx) {
  const review = require('../../src/modules/approvals/review.service');
  const { Agreement } = require('../../src/modules/approvals/models');
  const ll = await u('landlord@demo.local');
  await step('r5 revision also raises the commission (pending agreement)', async () => {
    const p = await Property.findById(L(ctx, 'r5')._id);
    if (!p.pendingRevision || p.pendingRevision.agreementId) return 'skip';
    await listings.acceptCommission(ll, String(p._id), { percent: 10, accept: true, typedName: ll.name }, fakeReq(ll));
    return true;
  });
  await step('r6 commission revision approved (old agreement superseded)', async () => {
    const p = await Property.findById(L(ctx, 'r6')._id);
    if (p.status !== 'live' || (await Agreement.countDocuments({ propertyId: p._id })) > 1) return 'skip';
    await listings.acceptCommission(ll, String(p._id), { percent: 12.5, accept: true, typedName: ll.name }, fakeReq(ll));
    await listings.submit(ll, String(p._id), fakeReq(ll));
    const admin = ctx.users.admin;
    await review.claim(String(p._id), fakeReq(admin));
    await review.decide(String(p._id), { decision: 'approve', checklist: Object.fromEntries(review.CHECKLIST.map((k) => [k, true])) }, fakeReq(admin));
    return true;
  });
  await step('s1 sold outside after a returned deal (priority claim, open)', async () => {
    const p = await Property.findById(L(ctx, 's1')._id);
    if (p.status !== 'live') return 'skip';
    const o2 = await u('owner2@demo.local');
    await listings.deactivate(o2, String(p._id), { reason: 'sold_outside', saleDate: new Date(Date.now() - 60000), price: 9300000, note: 'Sold to a buyer who came through a relative' }, fakeReq(o2));
    return true;
  });
  await step('r2 photo session picked up by QA', async () => {
    const sess = await VerificationSession.findOne({ propertyId: L(ctx, 'r2')._id, status: 'pending_review' });
    if (!sess || (sess.review && sess.review.claimUntil > new Date())) return 'skip';
    await verification.claim(String(sess._id), fakeReq(ctx.users['finance@demo.local']));
    return true;
  });
  await step('deleted draft', async () => {
    const owner = await u('owner@demo.local');
    if (await Property.exists({ listerId: owner._id, title: 'Old duplicate draft (deleted)' })) return 'skip';
    const req = fakeReq(owner);
    const p = await listings.createDraft(owner, { ...req, body: {} });
    await listings.saveStep(owner, String(p._id), 1, { purpose: 'sale', category: 'residential', type: 'apartment', title: 'Old duplicate draft (deleted)', description: 'Started by mistake while creating the Wakad listing; deleted by the owner from the drafts list.' }, req);
    await listings.softDelete(owner, String(p._id), req);
    return true;
  });
  await step('b5 RERA exemption approved by the reviewer', async () => {
    const p = await Property.findById(L(ctx, 'b5')._id);
    if (!p.rera || !p.rera.exempt || !p.rera.exempt.reason || p.rera.exempt.approvedBy) return 'skip';
    // The review approved the exemption (checklist rera_verified); the app does not record who, so the seed does.
    await col(Property).updateOne({ _id: p._id }, { $set: { 'rera.exempt.approvedBy': p.review.reviewedBy, 'rera.exempt.approvedAt': p.review.reviewedAt } });
    return true;
  });
}

module.exports = { seedLifecycle2, seedVerification, seedLifecycle, seedSearch, seedMasters };
