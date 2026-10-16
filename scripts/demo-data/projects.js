// Builder projects through the real projects service: tabs, RERA, media,
// agreement, submit and admin decision; unit inventory by CSV import.
const { Project, ProjectUnit, UnitImport } = require('../../src/modules/projects/models');
const { User } = require('../../src/modules/auth/models');
const projects = require('../../src/modules/projects/service');
const reraExpiry = require('../../src/modules/projects/rera-expiry');
const media = require('./media');
const { fakeReq, step, col, daysAhead, daysAgo } = require('./context');

const P = (o) => o;
const PROJECTS = [
  P({
    key: 'greens', builder: 'builder2@demo.local', name: 'Riverstone Greens', target: 'live', featured: true, locality: 'wakad', dx: 0.004, dy: -0.003, pincode: '411057',
    description: 'Riverstone Greens is a gated community of four towers on a seven acre plot in Wakad, a short drive from the Hinjewadi IT parks and the Mumbai Pune expressway. Two and three bedroom homes with large balconies, a landscaped central park and a clubhouse with a pool.',
    possession: { status: 'under_construction', date: daysAhead(420) }, amenities: ['lift', 'power_backup', 'security', 'gym', 'swimming_pool', 'club_house', 'park', 'parking', 'gas_pipeline', 'rainwater_harvesting'],
    landmarks: [{ type: 'it_park', name: 'Rajiv Gandhi Infotech Park' }, { type: 'highway', name: 'Mumbai Pune Expressway' }, { type: 'school', name: 'Indira National School' }, { type: 'hospital', name: 'Aditya Birla Memorial Hospital' }],
    configs: [
      { name: '2 BHK Classic', type: 'apartment', bhk: 2, carpetMin: 720, carpetMax: 790, priceMin: 8200000, priceMax: 9400000, totalUnits: 0, availableUnits: 0 },
      { name: '3 BHK Grande', type: 'apartment', bhk: 3, carpetMin: 1050, carpetMax: 1180, priceMin: 12500000, priceMax: 14800000, totalUnits: 0, availableUnits: 0 },
      { name: '4 BHK Sky Villa', type: 'apartment', bhk: 4, carpetMin: 1650, carpetMax: 1800, priceMin: 21000000, priceMax: 24500000, totalUnits: 0, availableUnits: 0 },
    ],
    rera: [{ number: 'P52100047812', state: 'Maharashtra', phaseLabel: 'Phase 1 (Towers A and B)', url: 'https://maharera.maharashtra.gov.in/projects/P52100047812', validTill: daysAhead(900) }],
    commission: 2.5, photos: ['Tower elevation', 'Clubhouse', 'Central park', 'Sample flat living room', 'Swimming pool'],
    video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    units: true,
  }),
  P({
    key: 'residency', builder: 'builder@demo.local', name: 'Skyline Residency', target: 'live', locality: 'hinjewadi', dx: -0.003, dy: 0.002, pincode: '411057',
    description: 'Skyline Residency is a compact mid-rise project next to Hinjewadi Phase 1 with one and two bedroom homes for working professionals. Ready possession of the first wing, rooftop garden and covered parking for every home.',
    possession: { status: 'ready' }, amenities: ['lift', 'power_backup', 'security', 'parking', 'park'],
    landmarks: [{ type: 'it_park', name: 'Hinjewadi Phase 1' }, { type: 'bus_stop', name: 'Shivaji Chowk bus stop' }],
    configs: [
      { name: '1 BHK Smart', type: 'apartment', bhk: 1, carpetMin: 420, carpetMax: 460, priceMin: 4200000, priceMax: 4800000, totalUnits: 24, availableUnits: 6 },
      { name: '2 BHK Comfort', type: 'apartment', bhk: 2, carpetMin: 640, carpetMax: 690, priceMin: 6400000, priceMax: 7100000, totalUnits: 30, availableUnits: 3 },
    ],
    // RERA registration ends in 20 days: the daily job flags the project as "expiring".
    rera: [{ number: 'P52100039921', state: 'Maharashtra', phaseLabel: 'Wing A', url: 'https://maharera.maharashtra.gov.in/projects/P52100039921', validTill: daysAhead(20) }],
    commission: 2, photos: ['Front elevation', 'Rooftop garden', 'Lobby'],
  }),
  P({
    key: 'edge', builder: 'builder2@demo.local', name: 'Riverstone Edge', target: 'pending_approval', locality: 'hinjewadi', dx: 0.006, dy: 0.004, pincode: '411057',
    description: 'Riverstone Edge is a boutique building of six premium homes on a 420 square metre plot near Hinjewadi Phase 2. Every home gets a private terrace and two covered parkings. Exempt from RERA registration as it has fewer than eight units.',
    possession: { status: 'under_construction', date: daysAhead(300) }, amenities: ['lift', 'security', 'parking'],
    landmarks: [{ type: 'it_park', name: 'Hinjewadi Phase 2' }],
    configs: [{ name: '3 BHK Terrace Home', type: 'apartment', bhk: 3, carpetMin: 1250, carpetMax: 1320, priceMin: 16500000, priceMax: 18000000, totalUnits: 6, availableUnits: 6 }],
    exempt: { reason: 'upto_8_units', plotAreaSqm: 420, units: 6 }, commission: 3, photos: ['Site view', 'Architect render'],
  }),
  P({
    key: 'towers2', builder: 'builder@demo.local', name: 'Skyline Towers Phase 2', target: 'changes_requested', locality: 'baner', dx: 0.005, dy: 0.003, pincode: '411045',
    description: 'Skyline Towers Phase 2 adds two towers of three bedroom homes to the existing Skyline community on Baner Pashan link road, with a new sports deck and an indoor games room for residents.',
    possession: { status: 'under_construction', date: daysAhead(700) }, amenities: ['lift', 'gym', 'club_house', 'security'],
    configs: [{ name: '3 BHK Premium', type: 'apartment', bhk: 3, carpetMin: 1100, carpetMax: 1200, priceMin: 15000000, priceMax: 17000000, totalUnits: 80, availableUnits: 80 }],
    rera: [{ number: 'P52100051234', state: 'Maharashtra', phaseLabel: 'Phase 2', url: 'https://maharera.maharashtra.gov.in/projects/P52100051234', validTill: daysAhead(1200) }],
    commission: 2, photos: ['Tower render', 'Sports deck render'],
    comments: [{ field: 'media', comment: 'Upload actual site photos; renders alone are not enough' }, { field: 'configurations', comment: 'Carpet area range does not match the RERA registration' }],
  }),
  P({
    key: 'arcade', builder: 'builder2@demo.local', name: 'Riverstone Arcade', target: 'rejected', locality: 'kharadi', dx: -0.004, dy: 0.002, pincode: '411014',
    description: 'Riverstone Arcade is a planned retail and office building on Kharadi bypass with ground floor shops and four floors of office space for small companies and clinics.',
    possession: { status: 'under_construction', date: daysAhead(900) }, amenities: ['lift', 'power_backup', 'parking'],
    configs: [{ name: 'Office unit', type: 'office', bhk: 0, carpetMin: 400, carpetMax: 1500, priceMin: 6000000, priceMax: 22000000, totalUnits: 40, availableUnits: 40 }],
    rera: [{ number: 'P52100099999', state: 'Maharashtra', url: 'https://maharera.maharashtra.gov.in/projects/P52100099999' }],
    commission: 2, photos: ['Concept render'], rejectReason: 'The RERA number belongs to a different project on MahaRERA',
  }),
];

function locOf(ctx, spec) {
  const l = ctx.localities[spec.locality];
  const [lng, lat] = l.centroid;
  return { cityId: String(ctx.cityId), localityId: String(l._id), lat: +(lat + (spec.dy || 0)).toFixed(6), lng: +(lng + (spec.dx || 0)).toFixed(6) };
}

async function ensureProject(ctx, spec) {
  const builder = await User.findOne({ email: spec.builder });
  const req = fakeReq(builder);
  let p = await Project.findOne({ builderId: builder._id, name: spec.name });
  if (!p) p = await projects.create(builder, { name: spec.name }, req);
  const id = String(p._id);
  if (['draft', 'changes_requested'].includes(p.status) && !p.description) {
    const loc = locOf(ctx, spec);
    await projects.saveTab(builder, id, 'details', { name: spec.name, description: spec.description, possession: spec.possession }, req);
    await projects.saveTab(builder, id, 'location', { cityId: loc.cityId, localityId: loc.localityId, addressLine: `${spec.name}, ${ctx.localities[spec.locality].name} main road`, pincode: spec.pincode, lat: loc.lat, lng: loc.lng, landmarks: spec.landmarks || [] }, req);
    await projects.saveTab(builder, id, 'configurations', { items: spec.configs }, req);
    await projects.saveTab(builder, id, 'amenities', { amenities: spec.amenities }, req);
    if (spec.exempt) {
      const plan = await media.uploadPdf(builder._id, 'rera_certificate', `Sanctioned plan - ${spec.name}`, ['Sanctioned building plan (demo)'], `plan:${spec.key}`);
      await projects.saveTab(builder, id, 'rera', { registrations: [], exempt: { ...spec.exempt, docFileId: String(plan._id) } }, req);
    } else {
      const regs = [];
      for (const r of spec.rera) {
        const cert = await media.uploadPdf(builder._id, 'rera_certificate', `RERA certificate ${r.number}`, [`Project: ${spec.name}`, `Registration: ${r.number}`], `rera:${r.number}`);
        regs.push({ ...r, certificateFileId: String(cert._id) });
      }
      await projects.saveTab(builder, id, 'rera', { registrations: regs }, req);
    }
  }
  p = await Project.findById(id);
  if (!(p.media.photos || []).length) {
    for (const [i, label] of spec.photos.entries()) {
      const f = await media.uploadPhoto(builder._id, 'project_media', label, `${spec.key}:photo:${i}`, { sub: spec.name });
      await projects.addMedia(builder, id, { kind: 'photo', fileId: String(f._id), caption: label });
    }
    if (spec.target === 'live' || spec.key === 'edge') {
      const b = await media.uploadPdf(builder._id, 'brochure', `${spec.name} brochure`, [spec.description, '', ...spec.configs.map((c) => `${c.name}: ${c.carpetMin}-${c.carpetMax} sq ft`)], `brochure:${spec.key}`);
      await projects.addMedia(builder, id, { kind: 'brochure', fileId: String(b._id) });
    }
  }
  p = await Project.findById(id);
  if (!p.activeAgreementId) await projects.acceptAgreement(builder, id, { percent: spec.commission, accept: true, typedName: builder.name }, req);
  p = await Project.findById(id);
  const admin = ctx.users.superadmin;
  const areq = fakeReq(admin);
  if (p.status === 'draft') { await projects.submit(builder, id, req); p = await Project.findById(id); }
  if (p.status === 'pending_approval' && spec.target !== 'pending_approval') {
    await projects.claim(id, areq);
    if (spec.target === 'live') await projects.decide(id, { decision: 'approve', checklist: { rera_verified: true, details_match: true, media_ok: true } }, areq);
    if (spec.target === 'changes_requested') await projects.decide(id, { decision: 'changes', comments: spec.comments }, areq);
    if (spec.target === 'rejected') await projects.decide(id, { decision: 'reject', reason: spec.rejectReason }, areq);
    p = await Project.findById(id);
  }
  if (spec.target === 'pending_approval' && p.status === 'pending_approval' && !(p.review && p.review.claimUntil > new Date())) {
    await projects.claim(id, areq); // in a reviewer's hands (claim lapses after 30 minutes)
  }
  if (p.status === 'live') await afterLive(ctx, spec, p, builder, admin);
  return Project.findById(id);
}

async function afterLive(ctx, spec, p, builder, admin) {
  const id = String(p._id);
  // Registration checked by the reviewer (no API sets these two fields; the review screen shows them).
  if (p.rera && p.rera.registrations.length && !p.rera.registrations[0].checkedBy) {
    await col(Project).updateOne({ _id: p._id }, { $set: { 'rera.registrations.$[].checkedBy': admin._id, 'rera.registrations.$[].checkedAt': p.liveAt || new Date() } });
  }
  if (spec.video && !(p.media.video && p.media.video.url)) await col(Project).updateOne({ _id: p._id }, { $set: { 'media.video': { kind: 'youtube', url: spec.video } } });
  if (spec.featured && !(p.featured && p.featured.on)) await projects.adminPatch(id, { action: 'feature' }, fakeReq(admin));
  // Floor plan per configuration (no API sets floorPlanFileId yet).
  const fresh = await Project.findById(id);
  for (const c of fresh.configurations) {
    if (c.floorPlanFileId) continue;
    const f = await media.uploadPhoto(builder._id, 'floor_plan', `Floor plan - ${c.name}`, `fp:${spec.key}:${c.name}`, { sub: `${c.carpetMin}-${c.carpetMax} sq ft carpet` });
    await col(Project).updateOne({ _id: p._id, 'configurations._id': c._id }, { $set: { 'configurations.$.floorPlanFileId': f._id } });
  }
  if (spec.units && !(await ProjectUnit.exists({ projectId: p._id }))) {
    const rows = ['tower,floor,unit_no,configuration,carpet_sqft,price,status'];
    const plan = [['A', '2 BHK Classic', 760, 8600000], ['B', '3 BHK Grande', 1120, 13400000], ['C', '4 BHK Sky Villa', 1720, 22800000]];
    const statuses = ['available', 'available', 'booked', 'sold', 'available', 'blocked', 'sold', 'available'];
    for (const [tower, conf, carpet, price] of plan) {
      for (let f = 1; f <= 8; f += 1) rows.push(`${tower},${f + 2},${tower}-${f + 2}01,${conf},${carpet},${price + f * 50000},${statuses[(f + tower.charCodeAt(0)) % statuses.length]}`);
    }
    const file = await media.uploadCsv(builder._id, rows.join('\n'), 'riverstone-greens-units.csv');
    const prev = await projects.importPreview(builder, id, { fileId: String(file._id) }, fakeReq(builder));
    await col(UnitImport).updateOne({ _id: prev.importId }, { $set: { fileId: file._id } });
    await projects.importConfirm(builder, id, String(prev.importId), fakeReq(builder));
    // A second upload with mistakes, left in preview, and an older discarded one.
    const bad = ['tower,floor,unit_no,configuration,carpet_sqft,price,status', 'D,4,D-401,2 BHK Classic,760,8700000,available', 'D,5,D-501,5 BHK Penthouse,2400,30000000,available', 'D,6,,3 BHK Grande,1100,13000000,available', 'D,7,D-701,3 BHK Grande,0,13000000,available', 'A,3,A-301,2 BHK Classic,760,8650000,reserved'];
    const badFile = await media.uploadCsv(builder._id, bad.join('\n'), 'tower-d-draft.csv');
    const p2 = await projects.importPreview(builder, id, { fileId: String(badFile._id) }, fakeReq(builder));
    await col(UnitImport).updateOne({ _id: p2.importId }, { $set: { fileId: badFile._id } });
    const p3 = await projects.importPreview(builder, id, { csv: 'tower,floor,unit_no,configuration,carpet_sqft,price,status\nE,1,E-101,2 BHK Classic,740,8300000,available' }, fakeReq(builder));
    await col(UnitImport).updateOne({ _id: p3.importId }, { $set: { status: 'discarded', createdAt: daysAgo(3) } });
    // Manual inventory correction (inventory log "manual").
    const after = await Project.findById(id);
    const c4 = after.configurations.find((c) => c.name === '4 BHK Sky Villa');
    if (c4 && c4.availableUnits > 0) await projects.updateInventory(builder, id, { items: [{ configId: String(c4._id), availableUnits: c4.availableUnits - 1 }] }, fakeReq(builder));
  }
}

async function seedProjects(ctx) {
  ctx.projects = ctx.projects || {};
  ctx.projects.heights = await Project.findOne({ projectNo: 'PRJ26-00001' });
  for (const spec of PROJECTS) {
    await step(`project ${spec.name}`, async () => { ctx.projects[spec.key] = await ensureProject(ctx, spec); return true; });
  }
  await step('RERA expiry job (flags Skyline Residency)', async () => { await reraExpiry.run(); return true; });
  for (const spec of PROJECTS) ctx.projects[spec.key] = await Project.findOne({ name: spec.name });
}

module.exports = { seedProjects, PROJECTS };
