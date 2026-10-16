// CMS content, notification template overrides, in-app notifications (read and
// unread), agreements (countersigned / terminated), visit availability, export
// jobs, report snapshots, a final timeline pass that spreads the demo leads'
// history over the last weeks, and the late account events (KYC rejection,
// broker ban) that suspend listings.
const { Banner, Faq, Testimonial } = require('../../src/modules/cms/models');
const { Notification, NotificationTemplate } = require('../../src/modules/notifications/models');
const { ExportJob, ReportSnapshot } = require('../../src/modules/reports/models');
const { Agreement } = require('../../src/modules/approvals/models');
const { VisitAvailability, Lead } = require('../../src/modules/leads/models');
const { Team } = require('../../src/modules/teams/models');
const { User } = require('../../src/modules/auth/models');
const cms = require('../../src/modules/cms/service');
const agreements = require('../../src/modules/approvals/agreements.service');
const reports = require('../../src/modules/reports/service');
const slots = require('../../src/modules/leads/slots.service');
const account = require('../../src/modules/auth/services/account.service');
const { notifyUser } = require('../../src/modules/notifications/service');
const { audit } = require('../../src/core/audit');
const media = require('./media');
const { fakeReq, step, col, daysAgo, daysAhead, DAY } = require('./context');

const u = (email) => User.findOne({ email }).select('+permissions');

async function seedCms(ctx) {
  const sa = ctx.users.superadmin;
  await step('banners', async () => {
    if (await Banner.exists({ title: 'Diwali home festival' })) return 'skip';
    const img = await media.uploadPhoto(sa._id, 'banner_image', 'Diwali home festival', 'banner:diwali', { w: 1600, h: 500, sub: 'Zero brokerage on verified homes' });
    await cms.banners.create({ title: 'Diwali home festival', imageFileId: String(img._id), imageUrl: img.url, link: '/search?city=pune&purpose=sale', cities: ['Pune'], startAt: daysAgo(5), endAt: daysAhead(25), active: true, sort: 1 }, fakeReq(sa));
    const img2 = await media.uploadPhoto(sa._id, 'banner_image', 'New: Riverstone Greens', 'banner:greens', { w: 1600, h: 500, sub: 'Wakad, 2 and 3 BHK' });
    await cms.banners.create({ title: 'New: Riverstone Greens', imageFileId: String(img2._id), imageUrl: img2.url, link: `/projects/${ctx.projects.greens && ctx.projects.greens.slug}`, cities: [], active: true, sort: 2 }, fakeReq(sa));
    await cms.banners.create({ title: 'Monsoon rentals (ended)', imageUrl: img2.url, link: '/search?purpose=rent', cities: ['Pune'], startAt: daysAgo(120), endAt: daysAgo(60), active: false, sort: 3 }, fakeReq(sa));
    return true;
  });
  await step('FAQs', async () => {
    if (await Faq.exists({ question: 'Do I pay any brokerage as a buyer?' })) return 'skip';
    const rows = [
      ['Buyers', 'Do I pay any brokerage as a buyer?', 'No. Buyers and tenants never pay brokerage. The owner or builder pays our sales team a commission they agreed to when listing.'],
      ['Buyers', 'Why can I not see the owner phone number?', 'Every enquiry goes to our sales team, who arrange visits and negotiate for you. This keeps brokers out and protects the owner.'],
      ['Buyers', 'What does Photo verified mean?', 'Someone at the property took live photos at the exact map pin and our team compared them with the listing photos.'],
      ['Owners', 'How long does listing approval take?', 'Most listings are reviewed within 24 hours once your KYC is verified.'],
      ['Owners', 'When do I pay the commission?', 'Only after a deal with a buyer introduced by us is verified. We send a GST invoice with 30 days to pay.'],
      ['Builders', 'Can I list individual units of my project?', 'Yes. Link a unit listing to your live project and it inherits the project location, amenities and RERA details.'],
    ];
    for (const [i, [group, question, answer]] of rows.entries()) await cms.faqs.create({ group, question, answer, sort: i, active: true }, fakeReq(sa));
    await cms.faqs.create({ group: 'Owners', question: 'Can I list my property on other portals too?', answer: 'Draft answer, pending legal review.', sort: 99, active: false }, fakeReq(sa));
    return true;
  });
  await step('testimonials', async () => {
    if (await Testimonial.exists({ name: 'Swati and Rahul' })) return 'skip';
    const rows = [
      ['Swati and Rahul', 'Pune', 'Found our 2 BHK in Wakad in three weeks. The agent handled every visit and the negotiation, and we paid no brokerage.', 5],
      ['Col. Deshpande (retd.)', 'Pune', 'Listed my Kothrud bungalow and got only serious buyers. No broker calls at all.', 5],
      ['Ankit Verma', 'Bengaluru', 'Rented a furnished flat in Kharadi before moving. Video call visit and quick paperwork.', 4],
    ];
    for (const [i, [name, city, text, rating]] of rows.entries()) await cms.testimonials.create({ name, city, text, rating, sort: i, active: true }, fakeReq(sa));
    await cms.testimonials.create({ name: 'Unverified review', city: 'Pune', text: 'Waiting for the customer to confirm before publishing.', rating: 3, active: false }, fakeReq(sa));
    return true;
  });
  await step('notification template overrides', async () => {
    if (await NotificationTemplate.exists({ key: 'listing.approved', channel: 'email' })) return 'skip';
    const rows = [
      { key: 'listing.approved', channel: 'email', subject: 'Your listing {{listingNo}} is now live', body: 'Hello {{name}}, good news: "{{title}}" ({{listingNo}}) passed our review and is live until {{expiresAt}}. Our sales team will call you before every visit.', urgent: false, active: true },
      { key: 'invoice.reminder', channel: 'sms', body: 'Reminder: invoice {{invoiceNo}} of INR {{outstanding}} is {{when}}. Pay by {{dueDate}}. -{{siteName}}', dltTemplateId: '1107169000012345678', urgent: false, active: true },
      { key: 'lead.created', channel: 'whatsapp', body: 'Hi {{name}}, thanks for your enquiry {{leadNo}}. Our sales expert will call you shortly.', waTemplateName: 'enquiry_received_v2', active: false },
    ];
    for (const r of rows) {
      const doc = await NotificationTemplate.findOneAndUpdate({ key: r.key, channel: r.channel }, { $set: { ...r, updatedBy: sa._id } }, { upsert: true, new: true });
      await audit(fakeReq(sa), { action: 'notification.template.update', entityType: 'NotificationTemplate', entityId: doc._id, after: r });
    }
    return true;
  });
}

async function seedAgreements(ctx) {
  const sa = ctx.users.superadmin;
  await step('agreement countersigned (o1)', async () => {
    const ag = await Agreement.findById(ctx.listings.o1.activeAgreementId);
    if (!ag || ag.status !== 'accepted') return 'skip';
    const f = await media.uploadPdf(sa._id, 'signed_agreement', `Countersigned ${ag.agreementNo}`, ['Signed by the platform and the owner'], `signed:${ag.agreementNo}`);
    await agreements.uploadSigned(String(ag._id), { fileId: String(f._id), signedDate: daysAgo(1) }, fakeReq(sa));
    return true;
  });
  await step('agreement terminated (x1, banned lister)', async () => {
    const p = ctx.listings.x1;
    const ag = p && await Agreement.findById(p.activeAgreementId);
    if (!ag || ag.status === 'terminated') return 'skip';
    await agreements.terminate(String(ag._id), { reason: 'Lister banned for broker activity' }, fakeReq(sa));
    await agreements.requestNewVersion(String(ctx.listings.o2.activeAgreementId), { note: 'New template version with the updated non-circumvention clause' }, fakeReq(sa));
    return true;
  });
}

async function seedAvailability(ctx) {
  await step('visit availability (landlord account + property, owner2 blackout)', async () => {
    const ll = await u('landlord@demo.local');
    if (await VisitAvailability.exists({ listerId: ll._id })) return 'skip';
    await slots.saveWeekly(ll, { scope: 'account', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '17:00', end: '20:00' })).concat([{ day: 6, start: '10:00', end: '18:00' }, { day: 0, start: '10:00', end: '13:00' }]), noticeHours: 4, note: 'Weekdays after office hours only' }, fakeReq(ll));
    await slots.saveWeekly(ll, { scope: 'property', scopeId: String(ctx.listings.r5._id), weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: '10:00', end: '17:00' })), noticeHours: 24, note: 'Office building: security needs a day notice' }, fakeReq(ll));
    const o2 = await u('owner2@demo.local');
    await slots.addBlackout(o2, { scope: 'account', from: daysAhead(20), to: daysAhead(24), reason: 'Out of town' }, fakeReq(o2));
    return true;
  });
}

async function seedReports(ctx) {
  const fin = ctx.users['finance@demo.local'];
  await step('export jobs (ready, failed, queued)', async () => {
    if (await ExportJob.exists({ requestedBy: fin._id })) return 'skip';
    const ok = await ExportJob.create({ requestedBy: fin._id, kind: 'report:listings', filters: { from: daysAgo(30).toISOString().slice(0, 10) }, status: 'queued' });
    await reports.runExport({ exportId: String(ok._id) });
    await ExportJob.create({ requestedBy: fin._id, kind: 'report:commission', filters: { groupBy: 'month' }, status: 'failed', error: 'Report query timed out after 30 s; try a shorter date range' });
    const buyer = await u('buyer@demo.local');
    await account.requestDataExport(buyer, fakeReq(buyer)); // queued; the dev API worker builds it
    return true;
  });
  await step('report snapshots', async () => {
    await reports.snapshot();
    const team = await Team.findOne({ name: 'Pune Sales' });
    const day = new Date(Date.now() + 330 * 60000 - DAY).toISOString().slice(0, 10);
    // 30 days of KPI history so the admin dashboard trend chart has a line (days before the seed only; real nights add on top).
    for (let i = 2; i <= 31; i += 1) {
      const d = new Date(Date.now() + 330 * 60000 - i * DAY).toISOString().slice(0, 10);
      const leadsN = 2 + ((i * 7) % 6); const visitsN = (i * 5) % 4; const won = i % 9 === 0 ? 1 : 0;
      await ReportSnapshot.updateOne({ key: 'daily_kpis', day: d, 'scope.teamId': null }, { $setOnInsert: { data: { leads: leadsN, visits: visitsN, dealsVerified: won, commission: won ? 18000000 + i * 100000 : 0 } } }, { upsert: true });
    }
    const r = await ReportSnapshot.updateOne({ key: 'lead_funnel', day, 'scope.teamId': team._id }, { $setOnInsert: { data: { new: 3, contacted: 5, qualified: 3, site_visit_scheduled: 1, site_visit_done: 2, negotiation: 4, booking: 2, closed_won: 6, closed_lost: 3 } } }, { upsert: true });
    return r.upsertedCount ? true : 'skip';
  });
}

// Every demo user gets a welcome notice; about half of each user's notices are marked read.
async function seedNotifications(ctx) {
  await step('notifications for every demo user (read and unread)', async () => {
    const users = await User.find({ email: /@demo\.local$/ });
    let n = 0;
    for (const user of users) {
      if (!(await Notification.exists({ userId: user._id, eventKey: 'auth.welcome' }))) {
        const roleNote = { buyer: 'Search, shortlist and enquire; our sales team arranges visits.', lister: 'Post listings, track buyer interest and invoices from your panel.', agent: 'Your leads, visits and follow-ups are in the agent panel.', manager: 'Team leads, routing and reports are in your panels.', admin: 'Approvals, finance and settings are in the admin panel.', superadmin: 'You hold every permission.' }[user.role];
        await notifyUser({ user, event: 'auth.welcome', channels: ['in_app'], vars: { roleNote, home: '/' } });
        n += 1;
      }
      const unreadOld = await Notification.find({ userId: user._id, readAt: null }).sort({ createdAt: 1 });
      const toRead = unreadOld.slice(0, Math.floor(unreadOld.length / 2));
      if (toRead.length && !(await Notification.exists({ userId: user._id, readAt: { $ne: null } }))) {
        await Notification.updateMany({ _id: { $in: toRead.map((x) => x._id) } }, { $set: { readAt: new Date() } });
      }
    }
    return n ? true : 'skip';
  });
}

// Spread each demo lead's timeline over the days since it was "created", so
// the activity history does not all read "today". Leads created by this seed
// only (never LD26-000001 / LD26-000002).
async function spreadTimelines(ctx) {
  await step('lead timelines spread over the last weeks', async () => {
    let n = 0;
    for (const [key, ref] of Object.entries(ctx.leads || {})) {
      if (!ref || !ref._id || key.endsWith('_lead')) continue;
      const lead = await Lead.findById(ref._id).lean();
      if (!lead || ['LD26-000001', 'LD26-000002'].includes(lead.leadNo) || lead.timeline.length < 2) continue;
      if (lead.timeline[0].at < daysAgo(1)) continue; // already spread on an earlier run
      const seed = [...lead.leadNo].reduce((a, c) => a + c.charCodeAt(0), 0);
      const days = lead.recycledFrom || lead.stage === 'new' ? 1 : 5 + (seed % 18);
      const start = Date.now() - days * DAY;
      const span = Date.now() - 60000 - start;
      const tl = lead.timeline.map((t, i) => ({ ...t, at: new Date(start + Math.round((span * i) / lead.timeline.length)) }));
      await col(Lead).updateOne({ _id: lead._id }, { $set: { timeline: tl, createdAt: lead.createdAt < new Date(start) ? lead.createdAt : new Date(start) } });
      n += 1;
    }
    return n ? true : 'skip';
  });
}

async function seedMore(ctx) {
  const sa = ctx.users.superadmin;
  const { AgreementTemplate, Page } = require('../../src/modules/cms/models');
  const Job = require('../../src/core/jobs/Job.model');
  const siteVisits = require('../../src/modules/approvals/site-visits.service');
  const { VerificationVisit } = require('../../src/modules/approvals/models');
  const { istAt } = require('./context');
  await step('agreement template v2 (rent) published', async () => {
    if (await AgreementTemplate.exists({ purpose: 'rent', version: { $gte: 2 } })) return 'skip';
    const v1 = await AgreementTemplate.findOne({ purpose: 'rent', status: 'published' }).sort({ version: -1 });
    const body = `${v1.body}\n6. Either party may end this agreement with 30 days written notice; deals with buyers or tenants already introduced stay commissionable for {{nonCircumventionMonths}} months.`;
    const t = await cms.createTemplate({ purpose: 'rent', body }, fakeReq(sa));
    await cms.publishTemplate(String(t._id), fakeReq(sa));
    return true;
  });
  await step('CMS page with an edit history', async () => {
    if (await Page.exists({ slug: 'buyer-guide' })) return 'skip';
    const pg = await cms.pages.create({ slug: 'buyer-guide', title: 'Home buyer guide', content: 'How visits, offers and bookings work on our platform.', meta: { title: 'Home buyer guide', description: 'Step by step guide for buyers' }, status: 'draft' }, fakeReq(sa));
    await cms.pages.update(String(pg._id), { content: 'How visits, offers and bookings work on our platform.\n\n1. Enquire. 2. Visit with our agent. 3. Make an offer. 4. Book with a token.', status: 'published' }, fakeReq(sa));
    return true;
  });
  await step('dead job in the queue (failed SMS provider)', async () => {
    if (await Job.exists({ type: 'notify.sms', status: 'dead' })) return 'skip';
    await Job.create({ type: 'notify.sms', payload: { to: '+919833000299', text: 'Your visit is confirmed (demo)' }, status: 'dead', attempts: 5, maxAttempts: 5, lastError: 'MSG91: 401 Invalid authkey', finishedAt: new Date(), runAt: daysAgo(1) });
    return true;
  });
  await step('lead retention: 2-year-old lost lead anonymised', async () => {
    const orig = ctx.leads.rc1;
    if (!orig || orig.anonymisedAt) return 'skip';
    const lead = await Lead.findById(orig._id).lean();
    const n = lead.timeline.length;
    const tl = lead.timeline.map((t, i) => ({ ...t, at: t.type === 'recycled' ? new Date(Date.now() - 2 * DAY) : new Date(daysAgo(830).getTime() + Math.round((30 * DAY * i) / n)) }));
    await col(Lead).updateOne({ _id: orig._id }, { $set: { timeline: tl, closedAt: daysAgo(800), createdAt: daysAgo(830), updatedAt: daysAgo(800), lastActivityAt: daysAgo(800) } });
    await reports.runRetention();
    return true;
  });
  await step('site visit outside the landlord slots (override) + a new request', async () => {
    const r1 = ctx.listings.r1;
    const v = await VerificationVisit.findOne({ propertyId: r1._id, status: 'requested' });
    if (!v) return 'skip';
    const fin = ctx.users['finance@demo.local'];
    const exec = await u('agent2@demo.local');
    let day = 2; while ([0, 6].includes(new Date(istAt(day, 11).getTime() + 330 * 60000).getUTCDay())) day += 1;
    await siteVisits.schedule(fin, { visitId: String(v._id), scheduledAt: istAt(day, 11, 0), executiveId: String(exec._id), overrideReason: 'Landlord agreed to a weekday morning visit on the phone' }, fakeReq(fin));
    const ll = await u('landlord@demo.local');
    await siteVisits.listerRequest(ll, String(ctx.listings.r6._id), { note: 'Shop is open 10 to 8, any day' }, fakeReq(ll));
    return true;
  });
}

module.exports = { seedMore, seedCms, seedAgreements, seedAvailability, seedReports, seedNotifications, spreadTimelines };
