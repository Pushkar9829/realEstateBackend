// Module G - Builder Projects (spec 4.7, workflows G1-G3): projects with RERA
// (RE-G-08), configurations, project-level agreement, inventory and CSV unit
// import with preview (RE-G-09). Prices in paise.
const { z } = require('zod');
const { Project, ProjectUnit, UnitImport } = require('./models');
const { Master } = require('../cms/models');
const { User } = require('../auth/models');
const agreements = require('../approvals/agreements.service');
const listingsSvc = require('../listings/service');
const guard = require('../masking/guard');
const storage = require('../../core/storage');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { toPoint } = require('../../core/geo');
const { toPaise } = require('../../core/money');
const { assertTransition } = require('../../constants/status');
const { notifyUser, notifyPermission } = require('../notifications/service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

const TABS = {
  details: z.object({ name: z.string().trim().min(3).max(120), description: z.string().trim().min(50).max(8000), possession: z.object({ status: z.enum(['ready', 'under_construction']), date: z.coerce.date().optional() }) }),
  location: z.object({ cityId: oid, localityId: oid, addressLine: z.string().trim().min(5).max(300), pincode: z.string().regex(/^[1-9][0-9]{5}$/), lat: z.coerce.number().min(6).max(37), lng: z.coerce.number().min(68).max(98), landmarks: z.array(z.object({ type: z.string().max(40), name: z.string().max(80) })).max(10).default([]) }),
  configurations: z.object({
    items: z.array(z.object({
      _id: oid.optional(), name: z.string().trim().min(2).max(60), type: z.string().max(40).optional(), bhk: z.number().int().min(0).max(20).optional(),
      carpetMin: z.number().positive(), carpetMax: z.number().positive(), priceMin: z.number().positive(), priceMax: z.number().positive(),
      totalUnits: z.number().int().min(0).max(10000), availableUnits: z.number().int().min(0).max(10000),
    }).refine((c) => c.carpetMin <= c.carpetMax && c.priceMin <= c.priceMax && c.availableUnits <= c.totalUnits, 'min <= max and available <= total')).min(1).max(30),
  }),
  amenities: z.object({ amenities: z.array(z.string().max(40)).max(80) }),
  rera: z.object({
    registrations: z.array(z.object({ number: z.string().trim().toUpperCase().min(5).max(40), state: z.string().trim().min(2).max(60), phaseLabel: z.string().max(60).optional(), url: z.string().url(), certificateFileId: oid, validTill: z.coerce.date().optional() })).max(10).default([]),
    exempt: z.object({ reason: z.enum(['plot_upto_500sqm', 'upto_8_units']), plotAreaSqm: z.number().positive(), units: z.number().int().positive(), docFileId: oid }).optional(),
  }).superRefine((r, ctx) => {
    if (r.exempt && r.exempt.plotAreaSqm > 500 && r.exempt.units > 8) ctx.addIssue({ code: 'custom', path: ['exempt'], message: 'RERA exemption applies only to plots up to 500 sq m or projects up to 8 units' });
  }),
};

async function ownProject(user, id) {
  const p = await Project.findOne({ _id: id, builderId: user._id });
  if (!p) throw ApiError.notFound('Project not found');
  return p;
}

function setStatus(p, to, actor, note) {
  assertTransition('project', p.status, to);
  p.statusHistory.push({ from: p.status, to, actor, note });
  p.status = to;
}

async function create(user, body, req) {
  const { name } = z.object({ name: z.string().trim().min(3).max(120) }).parse(body);
  const p = await Project.create({ projectNo: await counters.projectNo(), builderId: user._id, name, status: 'draft' });
  await audit(req, { action: 'project.create', entityType: 'Project', entityId: p._id });
  return p;
}

const listOwn = (user, query) => paginate(Project, { builderId: user._id, ...(query.status ? { status: query.status } : {}) }, query, { projection: 'projectNo name status location.city location.locality configurations liveAt updatedAt' });

async function saveTab(user, id, tab, body, req) {
  if (!TABS[tab]) throw ApiError.badRequest(`Tab must be one of ${Object.keys(TABS).join(', ')}`, 'INVALID_TAB');
  const d = TABS[tab].parse(body);
  const p = await ownProject(user, id);
  if (!['draft', 'changes_requested', 'live', 'sold_out'].includes(p.status)) throw ApiError.conflict(`A ${p.status} project cannot be edited`, 'PROJECT_LOCKED');
  const warnings = [];
  if (tab === 'details') {
    await guard.assertNoContactInfo({ name: d.name, description: d.description }, req);
    Object.assign(p, { name: d.name, description: d.description, possession: d.possession });
  }
  if (tab === 'location') {
    const city = await Master.findOne({ _id: d.cityId, type: 'city', active: true });
    const loc = city && await Master.findOne({ _id: d.localityId, type: 'locality', parentId: city._id, active: true });
    if (!loc) throw ApiError.validation([{ in: 'body', path: 'localityId', message: 'Choose a locality of the city' }]);
    p.location = { cityId: city._id, city: city.name, localityId: loc._id, locality: loc.name, addressLine: d.addressLine, pincode: d.pincode, landmarks: d.landmarks, geo: toPoint(d.lat, d.lng) };
  }
  if (tab === 'configurations') {
    const { Lead } = require('../leads/models');
    const keep = new Set(d.items.filter((c) => c._id).map((c) => c._id));
    for (const old of p.configurations) {
      if (!keep.has(String(old._id)) && await Lead.exists({ unitConfigId: old._id })) {
        throw ApiError.conflict(`Configuration "${old.name}" has enquiries; set its available units to 0 instead`, 'CONFIG_IN_USE');
      }
    }
    p.configurations = d.items.map((c) => ({ ...c, priceMin: toPaise(c.priceMin), priceMax: toPaise(c.priceMax) }));
  }
  if (tab === 'amenities') {
    const found = await Master.countDocuments({ type: 'amenity', code: { $in: d.amenities }, active: true });
    if (found !== new Set(d.amenities).size) throw ApiError.validation([{ in: 'body', path: 'amenities', message: 'Unknown amenity codes' }]);
    p.amenities = d.amenities;
  }
  if (tab === 'rera') {
    const files = [...d.registrations.map((r) => r.certificateFileId), d.exempt && d.exempt.docFileId].filter(Boolean);
    for (const fid of files) if (!(await storage.FileModel.exists({ _id: fid, ownerId: user._id }))) throw ApiError.validation([{ in: 'body', path: 'rera', message: 'Upload the RERA certificate / sanctioned plan first' }]);
    p.rera = { registrations: d.registrations, exempt: d.exempt };
    warnings.push(...await reraWarnings(p));
  }
  await p.save();
  return { project: p, warnings };
}

// RE-G-08 auto-checks for the reviewer: number pattern per state, URL host allow-list, uniqueness across builders.
async function reraWarnings(p) {
  const out = [];
  const patterns = await settings.get('rera.numberPatterns');
  const hosts = await settings.get('rera.urlHosts');
  for (const r of (p.rera && p.rera.registrations) || []) {
    if (patterns[r.state] && !new RegExp(patterns[r.state]).test(r.number)) out.push(`rera_number_format:${r.number}`);
    try { if (!hosts.includes(new URL(r.url).hostname)) out.push(`rera_url_host:${r.number}`); } catch { out.push(`rera_url_invalid:${r.number}`); }
    if (await Project.exists({ _id: { $ne: p._id }, builderId: { $ne: p.builderId }, 'rera.registrations.number': r.number })) out.push(`rera_number_reused:${r.number}`);
  }
  return out;
}

async function addMedia(user, id, body) {
  const d = z.object({ kind: z.enum(['photo', 'brochure']), fileId: oid, caption: z.string().max(100).optional() }).parse(body);
  const p = await ownProject(user, id);
  const purpose = d.kind === 'photo' ? 'project_media' : 'brochure';
  const file = await storage.FileModel.findOne({ _id: d.fileId, ownerId: user._id, purpose });
  if (!file) throw ApiError.badRequest(`Upload the file first (purpose ${purpose})`, 'FILE_NOT_FOUND');
  if (d.kind === 'photo') {
    if ((p.media.photos || []).length >= await settings.get('media.maxProjectPhotos')) throw ApiError.badRequest('Photo limit reached', 'PHOTO_LIMIT');
    p.media.photos.push({ fileId: file._id, url: file.url, caption: d.caption });
  } else p.media.brochure = { fileId: file._id, url: file.url };
  await p.save();
  return p.media;
}

async function acceptAgreement(user, id, body, req) {
  const { percent, typedName } = z.object({ percent: z.number().positive(), accept: z.literal(true), typedName: z.string().trim().min(2).max(120) }).parse(body);
  const p = await ownProject(user, id);
  const lister = await User.findById(user._id);
  const ag = await agreements.accept({ target: { kind: 'project', doc: p, purpose: 'project', ref: `${p.projectNo} - ${p.name}` }, percent, typedName, lister, req, pending: ['live', 'sold_out'].includes(p.status) });
  if (!['live', 'sold_out'].includes(p.status)) {
    p.activeAgreementId = ag._id;
    p.commission = { percent, acceptedAt: ag.acceptedAt };
    await p.save();
  }
  return { agreementId: ag._id, agreementNo: ag.agreementNo, version: ag.version, percent };
}

async function submit(user, id, req) {
  const p = await ownProject(user, id);
  if (!['draft', 'changes_requested'].includes(p.status)) throw ApiError.conflict(`A ${p.status} project cannot be submitted`, 'INVALID_TRANSITION');
  const missing = [];
  if (!p.description) missing.push('details');
  if (!p.location || !p.location.geo) missing.push('location');
  if (!p.configurations.length) missing.push('configurations');
  if (!p.activeAgreementId) missing.push('commission');
  const r = p.rera || {};
  const hasRera = (r.registrations || []).length > 0 || (r.exempt && r.exempt.reason);
  if (await settings.get('rera.requiredForProjects') && !hasRera) missing.push('rera');
  if (missing.length) throw ApiError.validation(missing.map((m) => ({ in: 'project', path: m, message: 'Required before submitting' })), `Complete: ${missing.join(', ')}`);
  setStatus(p, 'pending_approval', user._id, 'Submitted');
  await p.save();
  await audit(req, { action: 'project.submit', entityType: 'Project', entityId: p._id, after: { warnings: await reraWarnings(p) } });
  await notifyUser({ user, event: 'project.submitted', vars: { projectNo: p.projectNo, projectId: String(p._id) } });
  await notifyPermission('projects.approve', 'project.review_queued', { projectNo: p.projectNo, name: p.name, projectId: String(p._id) });
  return { status: p.status, warnings: await reraWarnings(p) };
}

// ---------------------------------------------------------------- inventory (RE-G-05)

function recomputeSoldOut(p, actor) {
  const allZero = p.configurations.length && p.configurations.every((c) => c.availableUnits === 0);
  if (p.status === 'live' && allZero) setStatus(p, 'sold_out', actor, 'All configurations sold out');
  else if (p.status === 'sold_out' && !allZero) setStatus(p, 'live', actor, 'Inventory added');
}

async function updateInventory(user, id, body, req) {
  const d = z.object({ items: z.array(z.object({ configId: oid, availableUnits: z.number().int().min(0), totalUnits: z.number().int().min(0).optional() })).min(1) }).parse(body);
  const p = await ownProject(user, id);
  for (const it of d.items) {
    const c = p.configurations.id(it.configId);
    if (!c) throw ApiError.notFound('Configuration not found');
    const total = it.totalUnits ?? c.totalUnits;
    if (it.availableUnits > total) throw ApiError.validation([{ in: 'body', path: 'availableUnits', message: 'Available units cannot exceed total units' }]);
    p.inventoryLog.push({ configId: c._id, from: c.availableUnits, to: it.availableUnits, by: user._id, reason: 'manual' });
    c.availableUnits = it.availableUnits;
    c.totalUnits = total;
  }
  recomputeSoldOut(p, user._id);
  await p.save();
  await audit(req, { action: 'project.inventory', entityType: 'Project', entityId: p._id, after: d.items });
  return { status: p.status, configurations: p.configurations };
}

// Called by deal verification (Phase 5): $inc guarded at > 0 (edge case G).
async function decrementOnDeal(projectId, configId, actor) {
  const r = await Project.updateOne({ _id: projectId, configurations: { $elemMatch: { _id: configId, availableUnits: { $gt: 0 } } } },
    { $inc: { 'configurations.$.availableUnits': -1 }, $push: { inventoryLog: { configId, by: actor, reason: 'deal', at: new Date() } } });
  const p = await Project.findById(projectId);
  if (p) { recomputeSoldOut(p, actor); await p.save(); }
  return { decremented: r.modifiedCount === 1, warning: r.modifiedCount === 1 ? null : 'Inventory already 0' };
}

// ---------------------------------------------------------------- CSV bulk unit upload (RE-G-09)

const CSV_HEADER = 'tower,floor,unit_no,configuration,carpet_sqft,price,status';
const unitsTemplate = () => `${CSV_HEADER}\nA,5,A-501,2 BHK Type A,750,8500000,available\n`;

function parseCsv(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(',').map((x) => x.trim()));
}

async function importPreview(user, id, body, req) {
  const p = await ownProject(user, id);
  let text = body.csv;
  if (body.fileId) {
    const f = await storage.FileModel.findOne({ _id: body.fileId, ownerId: user._id, purpose: 'unit_csv' });
    if (!f) throw ApiError.badRequest('Upload the CSV first (purpose unit_csv)', 'FILE_NOT_FOUND');
    text = require('fs').readFileSync(require('path').join(storage.localDir, f.key), 'utf8');
  }
  const rows = parseCsv(text);
  if (rows.length && rows[0][0].toLowerCase() === 'tower') rows.shift();
  const max = await settings.get('projects.bulkUploadMaxRows');
  if (rows.length > max) throw ApiError.badRequest(`At most ${max} rows per file`, 'TOO_MANY_ROWS');
  const byName = Object.fromEntries(p.configurations.map((c) => [c.name.toLowerCase(), c]));
  const existing = await ProjectUnit.find({ projectId: p._id }).lean();
  const key = (t, u) => `${t}|${u}`.toLowerCase();
  const exists = new Map(existing.map((u) => [key(u.tower, u.unitNo), u]));
  const seen = new Set();
  const preview = { create: [], update: [] };
  const errors = [];
  rows.forEach((r, i) => {
    const line = i + 2;
    const [tower, floor, unitNo, configuration, carpet, price, status = 'available'] = r;
    const fail = (reason) => errors.push({ line, reason });
    if (!tower || tower.length > 30) return fail('tower is required (1-30 chars)');
    if (!unitNo || unitNo.length > 30) return fail('unit no. is required (1-30 chars)');
    const f = Number(floor);
    if (!Number.isInteger(f) || f < -2 || f > 200) return fail('floor must be -2 to 200');
    const conf = byName[String(configuration || '').toLowerCase()];
    if (!conf) return fail(`unknown configuration "${configuration}"`);
    if (!(Number(carpet) > 0)) return fail('carpet area must be > 0');
    if (!['available', 'blocked', 'booked', 'sold'].includes(status)) return fail(`unknown status "${status}"`);
    const k = key(tower, unitNo);
    if (seen.has(k)) return fail('duplicate unit in this file');
    seen.add(k);
    const prev = exists.get(k);
    if (prev && prev.dealId && status === 'available') return fail('unit is linked to a deal and cannot be made available');
    const row = { tower, floor: f, unitNo, configId: conf._id, carpetSqft: Number(carpet), price: price ? toPaise(Number(price)) : undefined, status };
    if (row.price && (row.price < conf.priceMin || row.price > conf.priceMax)) row.warning = 'price outside configuration range';
    (prev ? preview.update : preview.create).push(row);
  });
  const imp = await UnitImport.create({ projectId: p._id, rows: rows.length, created: preview.create.length, updated: preview.update.length, rowErrors: errors, preview, by: user._id });
  await audit(req, { action: 'project.units.preview', entityType: 'Project', entityId: p._id, after: { rows: rows.length, errors: errors.length } });
  return { importId: imp._id, rows: rows.length, create: preview.create.length, update: preview.update.length, errors };
}

async function importConfirm(user, id, importId, req) {
  const p = await ownProject(user, id);
  const imp = await UnitImport.findOne({ _id: importId, projectId: p._id });
  if (!imp || imp.status !== 'previewed') throw ApiError.conflict('Import not found or already processed', 'INVALID_TRANSITION');
  const ops = [...imp.preview.create, ...imp.preview.update].map(({ warning, ...data }) => ({
    updateOne: { filter: { projectId: p._id, tower: data.tower, unitNo: data.unitNo }, update: { $set: { ...data, projectId: p._id } }, upsert: true },
  }));
  if (ops.length) await ProjectUnit.bulkWrite(ops, { ordered: false });
  // Recompute configuration totals from the unit inventory.
  const counts = await ProjectUnit.aggregate([{ $match: { projectId: p._id } }, { $group: { _id: '$configId', total: { $sum: 1 }, available: { $sum: { $cond: [{ $eq: ['$status', 'available'] }, 1, 0] } } } }]);
  counts.forEach((c) => {
    const conf = p.configurations.id(c._id);
    if (!conf) return;
    p.inventoryLog.push({ configId: conf._id, from: conf.availableUnits, to: c.available, by: user._id, reason: 'bulk_upload' });
    conf.totalUnits = c.total;
    conf.availableUnits = c.available;
  });
  recomputeSoldOut(p, user._id);
  await p.save();
  imp.status = 'confirmed';
  await imp.save();
  await audit(req, { action: 'project.units.confirm', entityType: 'Project', entityId: p._id, after: { created: imp.created, updated: imp.updated } });
  return { status: 'confirmed', configurations: p.configurations.map((c) => ({ _id: c._id, name: c.name, totalUnits: c.totalUnits, availableUnits: c.availableUnits })) };
}

async function listUnits(user, id, query) {
  const p = await ownProject(user, id);
  return paginate(ProjectUnit, { projectId: p._id, ...(query.status ? { status: query.status } : {}) }, query, { defaultSort: 'tower', maxLimit: 500 });
}

// ---------------------------------------------------------------- public (masked, RE-G-06)

const fewLeft = 5;
function publicView(p) {
  return {
    _id: p._id, projectNo: p.projectNo, slug: p.slug, name: p.name, // _id is needed to enquire (POST /leads/enquiry projectId) description: p.description, status: p.status, possession: p.possession,
    location: { city: p.location.city, locality: p.location.locality, landmarks: p.location.landmarks, publicGeo: p.location.publicGeo },
    configurations: p.configurations.map((c) => ({
      _id: c._id, name: c.name, type: c.type, bhk: c.bhk, carpetMin: c.carpetMin, carpetMax: c.carpetMax, priceMin: c.priceMin, priceMax: c.priceMax,
      availability: c.availableUnits === 0 ? 'sold_out' : c.availableUnits <= fewLeft ? 'few_left' : 'available', // exact counts are never public
    })),
    amenities: p.amenities,
    media: { photos: (p.media.photos || []).map((x) => ({ url: x.url, caption: x.caption })), brochure: Boolean(p.media.brochure && p.media.brochure.url) },
    rera: p.rera && p.rera.exempt && p.rera.exempt.reason
      ? { exempt: true, reason: p.rera.exempt.reason }
      : { registrations: ((p.rera && p.rera.registrations) || []).map((r) => ({ number: r.number, state: r.state, phaseLabel: r.phaseLabel, url: r.url })) },
    builder: { verified: true }, // never the builder's name, phone or email
  };
}

async function publicSearch(query) {
  const filter = { status: { $in: ['live', 'sold_out'] } };
  if (query.city) filter['location.city'] = new RegExp(`^${String(query.city).replace(/[.*+?^${}()|[\]\\]/g, '')}$`, 'i');
  if (query.q) filter.name = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const { items, meta } = await paginate(Project, filter, query, { lean: false, defaultSort: '-liveAt' });
  return { items: items.map(publicView), meta };
}

async function publicDetail(slug) {
  const p = await Project.findOne({ slug, status: { $in: ['live', 'sold_out'] } });
  if (!p) throw ApiError.notFound('Project not found');
  return publicView(p);
}

// ---------------------------------------------------------------- admin review (RE-G-02)

function adminQueue(query) {
  const filter = { status: query.status || 'pending_approval' };
  return paginate(Project, filter, query, { defaultSort: 'updatedAt', populate: { path: 'builderId', select: 'name email kyc.status brand' } });
}

async function adminDetail(id) {
  const p = await Project.findById(id).populate('builderId', 'name email phone kyc.status brand').populate('activeAgreementId').lean();
  if (!p) throw ApiError.notFound('Project not found');
  return { ...p, reraWarnings: await reraWarnings(p) };
}

async function claim(id, req) {
  const p = await Project.findById(id);
  if (!p) throw ApiError.notFound('Project not found');
  if (p.status !== 'pending_approval') throw ApiError.conflict('Nothing to review', 'INVALID_TRANSITION');
  if (p.review && p.review.claimUntil > new Date() && String(p.review.claimedBy) !== String(req.user._id)) throw ApiError.conflict('Another reviewer is working on this project', 'CLAIMED');
  p.review = { claimedBy: req.user._id, claimUntil: new Date(Date.now() + (await settings.get('review.claimMinutes')) * 60000) };
  await p.save();
  return p.review;
}

async function decide(id, body, req) {
  const d = z.object({
    decision: z.enum(['approve', 'changes', 'reject']),
    checklist: z.object({ rera_verified: z.boolean(), details_match: z.boolean(), media_ok: z.boolean() }).partial().optional(),
    comments: z.array(z.object({ field: z.string().max(60), comment: z.string().min(2).max(500) })).optional(),
    reason: z.string().trim().max(500).optional(),
  }).parse(body);
  const p = await Project.findById(id);
  if (!p) throw ApiError.notFound('Project not found');
  if (!p.review || String(p.review.claimedBy) !== String(req.user._id) || p.review.claimUntil < new Date()) throw ApiError.conflict('Claim the project before deciding', 'NOT_CLAIMED');
  const builder = await User.findById(p.builderId);
  if (d.decision === 'approve') {
    const c = d.checklist || {};
    if (!c.rera_verified || !c.details_match || !c.media_ok) throw ApiError.validation([{ in: 'body', path: 'checklist', message: 'Tick rera_verified, details_match and media_ok' }]);
    if (!builder.kyc || builder.kyc.status !== 'verified') throw new ApiError(409, 'APPROVAL_BLOCKED', 'Builder KYC is not verified');
    setStatus(p, 'live', req.user._id, 'Approved');
    p.liveAt = new Date();
    p.slug = p.slug || `${slugify(p.name)}-${p.projectNo.toLowerCase()}`;
    p.location.publicGeo = await listingsSvc.publicPoint({ _id: p._id, location: p.location });
    await agreements.activate(p.activeAgreementId);
  } else if (d.decision === 'changes') {
    if (!(d.comments && d.comments.length)) throw ApiError.validation([{ in: 'body', path: 'comments', message: 'Add at least one comment' }]);
    setStatus(p, 'changes_requested', req.user._id, 'Changes requested');
    p.reviewComments = d.comments.map((x) => ({ ...x, by: req.user._id, at: new Date() }));
  } else {
    if (!d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'A reason is required' }]);
    setStatus(p, 'rejected', req.user._id, d.reason);
    p.rejectionReason = d.reason;
  }
  p.review = undefined;
  await p.save();
  await audit(req, { action: `project.${d.decision}`, entityType: 'Project', entityId: p._id, reason: d.reason });
  await notifyUser({ user: builder, event: 'project.decided', channels: ['in_app', 'email'], vars: { projectNo: p.projectNo, projectId: String(p._id), decision: { approve: 'approved', changes: 'changes requested', reject: 'rejected' }[d.decision], note: d.reason || (d.comments || []).map((x) => x.comment).join('; ') } });
  return { status: p.status, slug: p.slug };
}

// RE-B-12: RERA certificates and exemption plans open through 10-minute signed links (audited).
async function adminFileUrl(id, fileId, req) {
  const p = await Project.findById(id).lean();
  if (!p) throw ApiError.notFound('Project not found');
  const r = p.rera || {};
  const ids = [...(r.registrations || []).map((x) => x.certificateFileId), r.exempt && r.exempt.docFileId].filter(Boolean).map(String);
  if (!ids.includes(String(fileId))) throw ApiError.notFound('File not found on this project');
  const file = await storage.FileModel.findById(fileId);
  if (!file) throw ApiError.notFound('File not found');
  await audit(req, { action: 'project.file_view', entityType: 'Project', entityId: p._id, after: { fileId: String(fileId) } });
  return { url: storage.urlFor(file, 600), expiresInSec: 600, mime: file.mime };
}

async function adminPatch(id, body, req) {
  const d = z.object({ action: z.enum(['deactivate', 'feature', 'unfeature']), reason: z.string().trim().min(3).max(500).optional() }).parse(body);
  const p = await Project.findById(id);
  if (!p) throw ApiError.notFound('Project not found');
  if (d.action === 'deactivate') {
    if (!d.reason) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'A reason is required' }]);
    setStatus(p, 'inactive', req.user._id, d.reason);
  } else p.featured = { on: d.action === 'feature' };
  await p.save();
  await audit(req, { action: `project.admin.${d.action}`, entityType: 'Project', entityId: p._id, reason: d.reason });
  return { status: p.status };
}

module.exports = {
  create, listOwn, saveTab, addMedia, acceptAgreement, submit, updateInventory, decrementOnDeal, unitsTemplate, importPreview, importConfirm, listUnits,
  publicSearch, publicDetail, publicView, adminQueue, adminDetail, adminFileUrl, claim, decide, adminPatch, ownProject, TABS,
};
