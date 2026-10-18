// Module A - Property Listing & Catalog Management (spec 4.1, workflows A1-A5).
// Prices are received in rupees and stored in paise.
const crypto = require('crypto');
const { Property, ListingCheck, SoldElsewhereCheck } = require('./models');
const { Master } = require('../cms/models');
const { User } = require('../auth/models');
const v = require('./validators');
const agreements = require('../approvals/agreements.service');
const kyc = require('../kyc/service');
const guard = require('../masking/guard');
const storage = require('../../core/storage');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { toPoint, distanceM } = require('../../core/geo');
const { toPaise } = require('../../core/money');
const { sha256 } = require('../../core/security/crypto');
const { assertTransition } = require('../../constants/status');
const { notifyUser, notifyPermission } = require('../notifications/service');
const env = require('../../config/env');
const { istDate } = require('../../core/format');

const FILE_PURPOSE = { photo: 'property_photo', floor_plan: 'floor_plan', brochure: 'brochure', video: 'property_video', ownership_proof: 'ownership_proof' };
const OPEN = ['live', 'paused', 'pending_approval', 'changes_requested'];
const EDITABLE = ['draft', 'changes_requested', 'pending_approval'];
const REVISABLE = ['live', 'paused'];
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const daysMs = (d) => d * 86400000;
const fmtDate = (d) => istDate(d); // dd/mm/yyyy, as in the web app

function setStatus(p, to, actor, note) {
  assertTransition('listing', p.status, to);
  const from = p.status;
  p.statusHistory.push({ from, to, actor, note });
  p.status = to;
  // Side jobs (RE-E-09 instant alerts, shortlist "no longer available"): queued, never block the change.
  const jobs = require('../../core/jobs');
  if (to === 'live' && from !== 'paused') jobs.enqueue('alerts.match', { propertyId: String(p._id) }, { delayMs: 5000 }).catch(() => {});
  if (from === 'live' && to !== 'live') jobs.enqueue('shortlist.unavailable', { propertyId: String(p._id), status: to }, { delayMs: 5000 }).catch(() => {});
}

async function ownListing(user, id) {
  const p = await Property.findOne({ _id: id, listerId: user._id, deletedAt: null });
  if (!p) throw ApiError.notFound('Listing not found');
  return p;
}

// Optimistic concurrency: the client may send the updatedAt it last saw.
function assertFresh(p, req) {
  const seen = req.headers['x-expected-updated-at'];
  if (seen && new Date(seen).getTime() !== p.updatedAt.getTime()) throw ApiError.conflict('Updated elsewhere, reload', 'STALE_WRITE');
}

// ---------------------------------------------------------------- create / read

async function createDraft(user, req, { link = true } = {}) {
  if (['rejected', 'banned'].includes(user.kyc && user.kyc.status)) throw ApiError.forbidden('Your verification was not approved, you cannot post listings', 'KYC_REJECTED');
  // RE-G-07: a builder may start a unit listing linked to one of their live projects.
  const body = (link && req.body) || {};
  const linkData = body.projectId ? v.projectLink.parse(body) : null;
  const listingNo = await counters.listingNo();
  const p = new Property({ listingNo, listerId: user._id, purpose: 'sale', category: 'residential', type: 'apartment', status: 'draft', wizard: { stepsDone: [], completeness: 0 } });
  if (linkData) await linkProject(p, user, linkData.projectId, linkData.unitConfigId);
  await p.save();
  await audit(req, { action: 'listing.create', entityType: 'Property', entityId: p._id, after: linkData ? { projectId: linkData.projectId } : undefined });
  return p;
}

// ---------------------------------------------------------------- linked unit listings (RE-G-07)

async function liveOwnProject(user, projectId) {
  if (user.listerType !== 'builder') throw ApiError.validation([{ in: 'body', path: 'projectId', message: 'Only builders can link a listing to a project' }]);
  const { Project } = require('../projects/models');
  const proj = await Project.findOne({ _id: projectId, builderId: user._id });
  if (!proj) throw ApiError.validation([{ in: 'body', path: 'projectId', message: 'Project not found among your projects' }]);
  if (proj.status !== 'live') throw ApiError.validation([{ in: 'body', path: 'projectId', message: 'Only live projects can have unit listings' }]);
  return proj;
}

// Location, amenities and RERA come from the project and are locked on the listing.
function inheritFromProject(p, proj) {
  const loc = proj.location ? (proj.location.toObject ? proj.location.toObject() : proj.location) : {};
  const own = p.location || {};
  p.location = {
    cityId: loc.cityId, city: loc.city, localityId: loc.localityId, locality: loc.locality, societyName: proj.name,
    addressLine: loc.addressLine, unitNo: own.unitNo, pincode: loc.pincode, landmarks: loc.landmarks || [], geo: loc.geo, publicGeo: loc.publicGeo,
  };
  p.amenities = [...(proj.amenities || [])];
  const r = proj.rera || {};
  const regs = r.registrations || [];
  p.rera = r.exempt && r.exempt.reason
    ? { numbers: [], exempt: { reason: r.exempt.reason, docFileId: r.exempt.docFileId, approvedBy: r.exempt.approvedBy, approvedAt: r.exempt.approvedAt }, inheritedFromProject: true }
    : { numbers: regs.map((x) => x.number), state: regs[0] && regs[0].state, url: regs[0] && regs[0].url, certificateFileId: regs[0] && regs[0].certificateFileId, inheritedFromProject: true };
  p.wizard.stepsDone = [...new Set([...(p.wizard.stepsDone || []), 2, 5])].sort();
  p.wizard.completeness = completeness(p);
}

async function linkProject(p, user, projectId, unitConfigId) {
  const proj = await liveOwnProject(user, projectId);
  const conf = proj.configurations.id(unitConfigId);
  if (!conf) throw ApiError.validation([{ in: 'body', path: 'unitConfigId', message: 'Choose a configuration of this project' }]);
  p.projectId = proj._id;
  p.unitConfigId = conf._id;
  inheritFromProject(p, proj);
  return { project: proj, config: conf };
}

function unlinkProject(p) {
  p.projectId = undefined;
  p.unitConfigId = undefined;
  if (p.rera) p.rera.inheritedFromProject = false;
}

// Short project summary shown on the lister's listing ("Part of <project>").
async function projectSummary(p) {
  if (!p.projectId) return null;
  const { Project } = require('../projects/models');
  const proj = await Project.findById(p.projectId).select('projectNo name slug status configurations').lean();
  if (!proj) return null;
  const conf = (proj.configurations || []).find((c) => String(c._id) === String(p.unitConfigId));
  return { _id: proj._id, projectNo: proj.projectNo, name: proj.name, slug: proj.slug, status: proj.status, config: conf ? { _id: conf._id, name: conf.name, bhk: conf.bhk } : null };
}

function listOwn(user, query) {
  const filter = { listerId: user._id, deletedAt: null };
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  return paginate(Property, filter, query, { projection: 'listingNo title purpose category type status location.locality location.city price media.photos stats liveAt expiresAt updatedAt wizard pause verification pendingRevision.submittedAt' });
}

async function getOwn(user, id) {
  const p = await ownListing(user, id);
  const out = p.toObject();
  const openCheck = await ListingCheck.findOne({ propertyId: p._id, answer: 'none', dueBy: { $gt: new Date() } }).select('trigger dueBy sentAt').lean();
  return { ...out, openCheck, project: await projectSummary(p) };
}

// ---------------------------------------------------------------- wizard steps

async function masterOr422(type, code, path, extra = {}) {
  const m = await Master.findOne({ type, code, active: true, ...extra });
  if (!m) throw ApiError.validation([{ in: 'body', path, message: `Unknown ${type.replace('_', ' ')} "${code}"` }]);
  return m;
}

async function applyStep(p, step, d, lister, warnings) {
  if (step === 2 && p.projectId) {
    // Linked unit listing: only the private unit number is the lister's own.
    p.location = { ...(p.location ? p.location.toObject() : {}), unitNo: d.unitNo };
    return;
  }
  if (step === 1) {
    if (d.projectId) await linkProject(p, lister, d.projectId, d.unitConfigId);
    else if (d.projectId === null && p.projectId) unlinkProject(p);
    const t = await masterOr422('property_type', d.type, 'type');
    if (t.meta && t.meta.category && t.meta.category !== d.category) throw ApiError.validation([{ in: 'body', path: 'type', message: `${t.name} is a ${t.meta.category} type` }]);
    Object.assign(p, { purpose: d.purpose, category: d.category, type: d.type, title: d.title, description: d.description, slug: `${slugify(d.title)}-${p.listingNo.toLowerCase()}` });
  }
  if (step === 2) {
    const city = await Master.findOne({ _id: d.cityId, type: 'city', active: true });
    if (!city) throw ApiError.validation([{ in: 'body', path: 'cityId', message: 'Unknown city' }]);
    let locality;
    if (d.localityId) {
      locality = await Master.findOne({ _id: d.localityId, type: 'locality', parentId: city._id, active: true });
      if (!locality) throw ApiError.validation([{ in: 'body', path: 'localityId', message: 'Locality does not belong to this city' }]);
    } else {
      // Lister asks for a locality that is not in the master; admin decides (L masters queue).
      const code = `${slugify(d.localityRequest)}-${p.listingNo.toLowerCase()}`;
      locality = await Master.findOneAndUpdate({ type: 'locality', code }, { $setOnInsert: { type: 'locality', code, name: d.localityRequest, parentId: city._id, active: false, request: { by: lister._id, propertyId: p._id, status: 'pending' } } }, { upsert: true, new: true });
      warnings.push('locality_requested');
    }
    const geo = toPoint(d.lat, d.lng);
    // RE-A-20: moving the exact pin more than 200 m removes the Photo verified badge.
    const ph = p.verification && p.verification.photo;
    if (ph && ph.status === 'verified' && p.location && p.location.geo && distanceM(geo, p.location.geo) > await settings.get('verification.photoMaxDistanceMeters')) {
      p.verification.photo = { status: 'none' };
      warnings.push('photo_badge_removed');
    }
    const maxKm = await settings.get('listing.pinMaxDistanceKm');
    if (locality.meta && locality.meta.centroid && distanceM(geo, locality.meta.centroid) > maxKm * 1000) warnings.push('pin_far_from_locality');
    p.location = {
      cityId: city._id, city: city.name, localityId: locality._id, locality: locality.name, societyName: d.societyName,
      addressLine: d.addressLine, unitNo: d.unitNo, pincode: d.pincode, landmarks: d.landmarks, geo, publicGeo: p.location && p.location.publicGeo,
    };
  }
  if (step === 3) {
    const f = v.TO_SQFT[d.areas.unit];
    const base = d.areas.carpet || d.areas.builtUp || d.areas.superBuiltUp || d.areas.plot;
    p.details = { ...d, areaSqft: Math.round(base * f) };
  }
  if (step === 4) {
    const s = await settings.all();
    const purpose = p.purpose;
    if (purpose === 'sale') {
      if (!d.amount) throw ApiError.validation([{ in: 'body', path: 'amount', message: 'Expected price is required' }]);
      if (d.amount < s['listing.minSalePrice'] || d.amount > s['listing.maxSalePrice']) throw ApiError.validation([{ in: 'body', path: 'amount', message: `Price must be between ${s['listing.minSalePrice']} and ${s['listing.maxSalePrice']}` }]);
    } else {
      if (!d.monthlyRent) throw ApiError.validation([{ in: 'body', path: 'monthlyRent', message: 'Monthly rent is required' }]);
      if (d.monthlyRent < s['listing.minRent'] || d.monthlyRent > s['listing.maxRent']) throw ApiError.validation([{ in: 'body', path: 'monthlyRent', message: `Rent must be between ${s['listing.minRent']} and ${s['listing.maxRent']}` }]);
      if (d.deposit && d.deposit > 24 * d.monthlyRent) throw ApiError.validation([{ in: 'body', path: 'deposit', message: 'Deposit cannot exceed 24 months of rent' }]);
    }
    const sqft = p.details && p.details.areaSqft;
    p.price = {
      amount: d.amount ? toPaise(d.amount) : undefined, monthlyRent: d.monthlyRent ? toPaise(d.monthlyRent) : undefined,
      deposit: d.deposit !== undefined ? toPaise(d.deposit) : undefined, maintenance: d.maintenance !== undefined ? toPaise(d.maintenance) : undefined,
      negotiable: d.negotiable, allInclusive: d.allInclusive,
      pricePerSqft: sqft ? Math.round(toPaise(d.amount || d.monthlyRent) / sqft) : undefined,
    };
  }
  if (step === 5) {
    const found = await Master.find({ type: 'amenity', code: { $in: d.amenities }, active: true }).select('code').lean();
    const unknown = d.amenities.filter((c) => !found.some((f) => f.code === c));
    if (unknown.length) throw ApiError.validation([{ in: 'body', path: 'amenities', message: `Unknown amenities: ${unknown.join(', ')}` }]);
    p.amenities = d.amenities;
  }
  if (step === 6) {
    if (d.video !== undefined) p.media.video = d.video ? { kind: 'youtube', url: d.video.url } : undefined;
    if (d.rera && p.projectId) throw ApiError.conflict('RERA details come from the linked project', 'INHERITED_FROM_PROJECT');
    if (d.rera) {
      if (lister.listerType !== 'builder') throw ApiError.validation([{ in: 'body', path: 'rera', message: 'RERA details apply to builder listings' }]);
      await validateRera(d.rera, lister, warnings);
      p.rera = { ...d.rera };
    }
  }
}

// RE-G-08: number pattern per state and the URL host are warnings for the reviewer; files must be the lister's.
async function validateRera(r, lister, warnings) {
  const patterns = await settings.get('rera.numberPatterns');
  const hosts = await settings.get('rera.urlHosts');
  if (r.state && patterns[r.state] && r.numbers.some((n) => !new RegExp(patterns[r.state]).test(n))) warnings.push('rera_number_format');
  if (r.url) {
    const host = new URL(r.url).hostname;
    if (!hosts.includes(host)) warnings.push('rera_url_host');
  }
  for (const fid of [r.certificateFileId, r.exempt && r.exempt.docFileId].filter(Boolean)) {
    if (!(await storage.FileModel.exists({ _id: fid, ownerId: lister._id }))) throw ApiError.validation([{ in: 'body', path: 'rera', message: 'Upload the RERA certificate / sanctioned plan first' }]);
  }
}

function completeness(p) {
  return Math.round(((p.wizard.stepsDone || []).filter((s) => s >= 1 && s <= 7).length / 7) * 100);
}

async function saveStep(user, id, stepRaw, body, req) {
  const step = Number(stepRaw);
  if (!v.steps[step]) throw ApiError.badRequest('Step must be 1-6 (commission and submit have their own endpoints)', 'INVALID_STEP');
  const p = await ownListing(user, id);
  // RE-G-07: a linked unit listing inherits location (except the unit number) and amenities.
  if (p.projectId && step === 5) throw ApiError.conflict('Amenities come from the linked project', 'INHERITED_FROM_PROJECT');
  const data = (p.projectId && step === 2 ? v.linkedLocation : v.steps[step]).parse(body);
  assertFresh(p, req);
  if (step === 1) await guard.assertNoContactInfo({ title: data.title, description: data.description }, req);
  if (step === 2 && data.societyName) await guard.assertNoContactInfo({ societyName: data.societyName }, req);

  // A2: live / paused listings take edits as a pending revision.
  if (REVISABLE.includes(p.status)) {
    if (step === 4 && Object.keys(data).every((k) => ['amount', 'monthlyRent', 'negotiable', 'allInclusive'].includes(k))) {
      const before = p.price.amount || p.price.monthlyRent;
      const after = toPaise(data.amount || data.monthlyRent);
      const pct = await settings.get('listing.minorPriceChangePercent');
      if (before && Math.abs(after - before) / before <= pct / 100) {
        // keep the other price fields (deposit, maintenance) as they are
        const keep = {};
        if (p.price.deposit != null) keep.deposit = p.price.deposit / 100;
        if (p.price.maintenance != null) keep.maintenance = p.price.maintenance / 100;
        await applyStep(p, 4, { ...keep, ...data }, user, []);
        await p.save();
        await audit(req, { action: 'listing.price_minor_change', entityType: 'Property', entityId: p._id, before: { price: before }, after: { price: after } });
        require('../search/service').onPriceChange(p, before, after).catch(() => {}); // RE-E-10
        return { applied: 'live', listing: p };
      }
    }
    p.pendingRevision = p.pendingRevision || {};
    p.pendingRevision.changes = { ...((p.pendingRevision && p.pendingRevision.changes) || {}), [step]: data };
    p.pendingRevision.submittedAt = undefined;
    p.markModified('pendingRevision');
    await p.save();
    return { applied: 'revision', pendingRevision: p.pendingRevision };
  }
  if (!EDITABLE.includes(p.status)) throw ApiError.conflict(`A ${p.status} listing cannot be edited`, 'LISTING_LOCKED');

  const warnings = [];
  await applyStep(p, step, data, user, warnings);
  p.wizard.stepsDone = [...new Set([...(p.wizard.stepsDone || []), step])].sort();
  p.wizard.completeness = completeness(p);
  p.warnings = [...new Set([...(p.warnings || []).filter((w) => !['pin_far_from_locality', 'rera_number_format', 'rera_url_host'].includes(w) || step !== 2 && step !== 6), ...warnings])];
  await p.save();
  return { applied: 'draft', listing: p, warnings };
}

// ---------------------------------------------------------------- media (RE-A-05..07, RE-F-03)

async function addMedia(user, id, body, req) {
  const d = v.media.parse(body);
  const p = await ownListing(user, id);
  if (![...EDITABLE, ...REVISABLE].includes(p.status)) throw ApiError.conflict(`A ${p.status} listing cannot be edited`, 'LISTING_LOCKED');
  const file = await storage.FileModel.findOne({ _id: d.fileId, ownerId: user._id, purpose: FILE_PURPOSE[d.kind] });
  if (!file) throw ApiError.badRequest(`Upload the file first (purpose ${FILE_PURPOSE[d.kind]})`, 'FILE_NOT_FOUND');
  const s = await settings.all();
  if (d.kind === 'photo') {
    if ((p.media.photos || []).length >= s['media.maxPhotos']) throw ApiError.badRequest(`Up to ${s['media.maxPhotos']} photos per listing`, 'PHOTO_LIMIT');
    p.media.photos.push({ fileId: file._id, url: file.url, thumbUrl: file.meta && file.meta.thumbUrl, caption: d.caption, tag: d.tag, hash: file.meta && file.meta.ahash, isCover: !(p.media.photos || []).length, sort: (p.media.photos || []).length });
  } else if (d.kind === 'floor_plan') {
    if ((p.media.floorPlans || []).length >= 10) throw ApiError.badRequest('Up to 10 floor plans', 'FLOOR_PLAN_LIMIT');
    p.media.floorPlans.push({ fileId: file._id, url: file.url, label: d.label });
  } else if (d.kind === 'brochure') {
    p.media.brochure = { fileId: file._id, url: file.url };
  } else if (d.kind === 'video') {
    p.media.video = { kind: 'upload', fileId: file._id, url: file.url };
  } else {
    p.media.ownershipProofs.push({ fileId: file._id, docType: d.docType || 'other' });
  }
  file.attachedTo = { type: 'Property', id: p._id };
  await file.save();
  if (REVISABLE.includes(p.status)) { p.pendingRevision = { ...(p.pendingRevision || {}), changes: { ...((p.pendingRevision && p.pendingRevision.changes) || {}), media: true } }; p.markModified('pendingRevision'); }
  await p.save();
  return p.media;
}

async function editMedia(user, id, mediaId, body) {
  const d = v.mediaEdit.parse(body);
  const p = await ownListing(user, id);
  const photo = p.media.photos.id(mediaId);
  const plan = (p.media.floorPlans || []).find((f) => String(f.fileId) === mediaId);
  if (photo) Object.assign(photo, { caption: d.caption ?? photo.caption, tag: d.tag ?? photo.tag });
  else if (plan) plan.label = d.label ?? plan.label;
  else throw ApiError.notFound('Media item not found');
  await p.save();
  return p.media;
}

async function orderMedia(user, id, body) {
  const { photoIds, coverId } = v.mediaOrder.parse(body);
  const p = await ownListing(user, id);
  const byId = Object.fromEntries(p.media.photos.map((ph) => [String(ph._id), ph]));
  if (photoIds.length !== p.media.photos.length || photoIds.some((x) => !byId[x])) throw ApiError.validation([{ in: 'body', path: 'photoIds', message: 'Send every photo id exactly once' }]);
  photoIds.forEach((x, i) => { byId[x].sort = i; byId[x].isCover = coverId ? x === coverId : i === 0; });
  p.media.photos.sort((a, b) => a.sort - b.sort);
  await p.save();
  return p.media;
}

async function removeMedia(user, id, mediaId) {
  const p = await ownListing(user, id);
  const photo = p.media.photos.id(mediaId);
  if (photo) {
    const wasCover = photo.isCover;
    photo.deleteOne();
    if (wasCover && p.media.photos.length) p.media.photos[0].isCover = true;
  } else {
    const before = (p.media.floorPlans || []).length + (p.media.ownershipProofs || []).length;
    p.media.floorPlans = (p.media.floorPlans || []).filter((f) => String(f.fileId) !== mediaId);
    p.media.ownershipProofs = (p.media.ownershipProofs || []).filter((f) => String(f.fileId) !== mediaId);
    if (p.media.brochure && String(p.media.brochure.fileId) === mediaId) p.media.brochure = undefined;
    else if (p.media.video && String(p.media.video.fileId) === mediaId) p.media.video = undefined;
    else if ((p.media.floorPlans || []).length + (p.media.ownershipProofs || []).length === before) throw ApiError.notFound('Media item not found');
  }
  await p.save();
  return p.media;
}

// ---------------------------------------------------------------- commission (step 7, RE-A-09/10)

async function currentTemplate(purpose) {
  const t = await require('../cms/service').currentTemplate(['sale', 'rent', 'project'].includes(purpose) ? purpose : 'sale');
  if (!t) throw ApiError.notFound('No published agreement template for this purpose');
  return { purpose: t.purpose, version: t.version, body: t.body, limits: await agreements.commissionLimits(purpose), nonCircumventionMonths: await settings.get('agreement.nonCircumventionMonths') };
}

async function acceptCommission(user, id, body, req) {
  const { percent, typedName } = v.commission.parse(body);
  const p = await ownListing(user, id);
  if (![...EDITABLE, ...REVISABLE].includes(p.status)) throw ApiError.conflict(`A ${p.status} listing cannot be edited`, 'LISTING_LOCKED');
  if (!p.wizard.stepsDone.includes(1)) throw ApiError.conflict('Complete the basic details first', 'STEP_ORDER');
  const lister = await User.findById(user._id);
  if (p.projectId) {
    const { Project } = require('../projects/models');
    const proj = await Project.findById(p.projectId).select('commission').lean();
    if (proj && proj.commission && proj.commission.percent && percent < proj.commission.percent) {
      throw ApiError.validation([{ in: 'body', path: 'percent', message: `A unit listing may only raise the project commission (${proj.commission.percent}%)` }]);
    }
  }
  const revision = REVISABLE.includes(p.status);
  const ag = await agreements.accept({ target: { kind: 'property', doc: p, purpose: p.purpose, ref: `${p.listingNo} - ${p.title}` }, percent, typedName, lister, req, pending: revision });
  if (revision) {
    p.pendingRevision = { ...(p.pendingRevision || {}), agreementId: ag._id, changes: { ...((p.pendingRevision && p.pendingRevision.changes) || {}), commission: { percent } } };
    p.markModified('pendingRevision');
  } else {
    p.activeAgreementId = ag._id;
    p.commission = { percent, acceptedAt: ag.acceptedAt, acceptedIp: ag.ip, acceptedName: typedName };
    p.wizard.stepsDone = [...new Set([...p.wizard.stepsDone, 7])].sort();
    p.wizard.completeness = completeness(p);
  }
  await p.save();
  return { agreementId: ag._id, agreementNo: ag.agreementNo, version: ag.version, percent, pendingRevision: revision };
}

// ---------------------------------------------------------------- submit (A1 step 5)

async function autoChecks(p, lister) {
  const warnings = new Set((p.warnings || []).filter((w) => ['locality_requested', 'pin_far_from_locality', 'rera_number_format', 'rera_url_host'].includes(w)));
  if (p.location && p.location.unitNo) {
    const dup = await Property.exists({ _id: { $ne: p._id }, 'location.pincode': p.location.pincode, 'location.unitNo': p.location.unitNo, type: p.type, status: { $in: OPEN }, deletedAt: null });
    if (dup) warnings.add('duplicate_unit');
  }
  const hashes = p.media.photos.map((ph) => ph.hash).filter(Boolean);
  if (hashes.length && await Property.exists({ _id: { $ne: p._id }, 'media.photos.hash': { $in: hashes }, deletedAt: null })) warnings.add('duplicate_photos');
  const key = p.purpose === 'sale' ? 'price.pricePerSqft' : 'price.pricePerSqft';
  if (p.price && p.price.pricePerSqft && p.location && p.location.localityId) {
    const peers = await Property.find({ _id: { $ne: p._id }, status: 'live', purpose: p.purpose, 'location.localityId': p.location.localityId, [key]: { $gt: 0 } }).select(key).limit(200).lean();
    if (peers.length >= 5) {
      const sorted = peers.map((x) => x.price.pricePerSqft).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (p.price.pricePerSqft > median * 1.5 || p.price.pricePerSqft < median * 0.5) warnings.add('price_outlier');
    }
  }
  const { min } = await agreements.commissionLimits(p.purpose);
  if (p.commission && p.commission.percent < min) warnings.add('commission_below_current_min');
  const contactHits = await guard.findContactInfo(`${p.title || ''} ${p.description || ''}`);
  if (contactHits.length) warnings.add('contact_patterns');
  if (lister.listerType === 'builder' && p.rera && !p.rera.numbers.length && !p.rera.exempt) warnings.add('rera_missing');
  return [...warnings];
}

async function missingForSubmit(p, lister) {
  const missing = [];
  for (let s = 1; s <= 5; s += 1) if (!p.wizard.stepsDone.includes(s)) missing.push(`step${s}`);
  const minPhotos = await settings.get('media.minPhotos');
  if (p.media.photos.filter((ph) => ph.moderation.status !== 'rejected').length < minPhotos) missing.push(`step6:photos(min ${minPhotos})`);
  if (lister.listerType !== 'builder' && !(p.media.ownershipProofs || []).length) missing.push('step6:ownership_proof');
  if (lister.listerType === 'builder' && await settings.get('rera.requiredForBuilderListings')) {
    const r = p.rera || {};
    const hasNumber = (r.numbers || []).length && r.url && r.certificateFileId;
    if (!hasNumber && !(r.exempt && r.exempt.reason)) missing.push('step6:rera');
  }
  if (!p.wizard.stepsDone.includes(7) || !p.activeAgreementId) missing.push('step7:commission');
  return missing;
}

async function submit(user, id, req) {
  const p = await ownListing(user, id);
  const lister = await User.findById(user._id);
  // A2: submitting a revision of a live listing.
  if (REVISABLE.includes(p.status)) {
    if (!p.pendingRevision || !p.pendingRevision.changes) throw ApiError.conflict('Nothing to submit', 'NO_REVISION');
    p.pendingRevision.submittedAt = new Date();
    p.markModified('pendingRevision');
    await p.save();
    await notifyPermission('properties.approve', 'listing.review_queued', { listingNo: p.listingNo, title: `${p.title} (revision)`, propertyId: String(p._id) });
    return { status: p.status, revision: 'submitted' };
  }
  if (!['draft', 'changes_requested'].includes(p.status)) throw ApiError.conflict(`A ${p.status} listing cannot be submitted`, 'INVALID_TRANSITION');
  if (p.projectId) inheritFromProject(p, await liveOwnProject(lister, p.projectId)); // latest project location / RERA
  const missing = await missingForSubmit(p, lister);
  if (missing.length) throw ApiError.validation(missing.map((m) => ({ in: 'listing', path: m, message: 'Required before submitting' })), `Complete the missing steps: ${missing.join(', ')}`);
  if (p.status === 'changes_requested') {
    if (p.resubmissionCount >= await settings.get('listing.maxResubmissions')) throw ApiError.conflict('Maximum resubmissions reached, contact support', 'RESUBMISSION_LIMIT');
    p.resubmissionCount += 1;
  }
  p.warnings = await autoChecks(p, lister);
  p.submittedAt = new Date();
  setStatus(p, 'pending_approval', user._id, 'Submitted');
  await p.save();
  await kyc.checkListingLimit(lister); // R2
  await kyc.checkPhotoReuse(p); // R3
  await audit(req, { action: 'listing.submit', entityType: 'Property', entityId: p._id, after: { warnings: p.warnings } });
  await notifyUser({ user: lister, event: 'listing.submitted', channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, slaHours: await settings.get('listing.reviewSlaHours'), propertyId: String(p._id) } });
  await notifyPermission('properties.approve', 'listing.review_queued', { listingNo: p.listingNo, title: p.title, propertyId: String(p._id) });
  return { status: p.status, warnings: p.warnings };
}

async function withdraw(user, id, req) {
  const p = await ownListing(user, id);
  setStatus(p, 'draft', user._id, 'Withdrawn by lister');
  p.review = { ...(p.review ? p.review.toObject() : {}), claimedBy: undefined, claimUntil: undefined };
  await p.save();
  await audit(req, { action: 'listing.withdraw', entityType: 'Property', entityId: p._id });
  return p;
}

// ---------------------------------------------------------------- lifecycle (A3, RE-A-15, RE-A-18)

const expiryDaysFor = (purpose) => settings.get(`listing.expiryDays.${purpose === 'rent' ? 'rent' : 'sale'}`);

async function renew(user, id, req) {
  const p = await ownListing(user, id);
  const now = Date.now();
  const days = await expiryDaysFor(p.purpose);
  const grace = await settings.get('listing.renewGraceDays');
  const kycOk = user.kyc && user.kyc.status === 'verified';
  if (p.status === 'live') {
    if (p.expiresAt && p.expiresAt.getTime() - now > daysMs(15)) throw ApiError.conflict('Renewal opens 15 days before expiry', 'TOO_EARLY');
    p.expiresAt = new Date(now + daysMs(days));
  } else if (p.status === 'expired') {
    if (kycOk && p.expiresAt && now - p.expiresAt.getTime() <= daysMs(grace) && !(p.pendingRevision && p.pendingRevision.changes)) {
      setStatus(p, 'live', user._id, 'Renewed');
      p.expiresAt = new Date(now + daysMs(days));
    } else {
      setStatus(p, 'pending_approval', user._id, 'Renewed after grace period - review required');
      p.submittedAt = new Date();
    }
  } else throw ApiError.conflict(`A ${p.status} listing cannot be renewed`, 'INVALID_TRANSITION');
  p.availability = { ...(p.availability ? p.availability.toObject() : {}), lastConfirmedAt: new Date() };
  await p.save();
  await audit(req, { action: 'listing.renew', entityType: 'Property', entityId: p._id, after: { status: p.status, expiresAt: p.expiresAt } });
  return { status: p.status, expiresAt: p.expiresAt };
}

async function dealUnderVerification(propertyId) {
  const { Deal } = require('../deals/models');
  return Deal.exists({ propertyId, status: { $in: ['submitted', 'under_review'] } });
}

async function deactivate(user, id, body, req) {
  const d = v.deactivate.parse(body);
  const p = await ownListing(user, id);
  if (!['live', 'paused'].includes(p.status)) throw ApiError.conflict(`A ${p.status} listing cannot be taken off market`, 'INVALID_TRANSITION');
  if (await dealUnderVerification(p._id)) throw ApiError.conflict('A deal is under verification for this listing', 'DEAL_PENDING');
  if (['sold_outside', 'rented_outside'].includes(d.reason)) return soldElsewhere(p, { saleDate: d.saleDate, price: d.price, source: 'deactivation', reason: d.reason }, req);
  setStatus(p, 'inactive', user._id, d.note || d.reason);
  p.inactiveReason = d.reason;
  await p.save();
  await audit(req, { action: 'listing.deactivate', entityType: 'Property', entityId: p._id, reason: d.reason });
  return { status: p.status };
}

async function reactivate(user, id, req) {
  const p = await ownListing(user, id);
  setStatus(p, 'pending_approval', user._id, 'Reactivated');
  p.inactiveReason = undefined;
  p.submittedAt = new Date();
  await p.save();
  await audit(req, { action: 'listing.reactivate', entityType: 'Property', entityId: p._id });
  await notifyPermission('properties.approve', 'listing.review_queued', { listingNo: p.listingNo, title: p.title, propertyId: String(p._id) });
  return { status: p.status };
}

async function duplicate(user, id, req) {
  const src = await ownListing(user, id);
  const copy = await createDraft(user, req, { link: false });
  ['purpose', 'category', 'type', 'description', 'details', 'amenities', 'projectId', 'unitConfigId', 'rera'].forEach((k) => { copy[k] = src[k]; });
  copy.title = src.title ? `${src.title} (copy)`.slice(0, 100) : undefined;
  copy.location = src.location ? { ...src.location.toObject(), unitNo: undefined } : undefined;
  copy.wizard = { stepsDone: (src.wizard.stepsDone || []).filter((s) => [1, 2, 3, 5].includes(s)), completeness: 0 };
  copy.wizard.completeness = completeness(copy);
  await copy.save();
  return copy;
}

async function softDelete(user, id, req) {
  const p = await ownListing(user, id);
  if (p.status !== 'draft') throw ApiError.conflict('Only drafts can be deleted; take a live listing off market instead', 'NOT_A_DRAFT');
  p.deletedAt = new Date();
  await p.save();
  await audit(req, { action: 'listing.delete_draft', entityType: 'Property', entityId: p._id });
  return { deleted: true };
}

async function pause(user, id, body, req) {
  const { reason } = v.pause.parse(body);
  const p = await ownListing(user, id);
  setStatus(p, 'paused', user._id, reason);
  p.pause = { reason: 'lister', note: reason, pausedAt: new Date(), by: user._id };
  await p.save();
  await audit(req, { action: 'listing.pause', entityType: 'Property', entityId: p._id, reason });
  return { status: p.status };
}

// Resume: live again while expiresAt is in the future (no review), else expired.
async function resumeListing(p, actor, { asAdmin = false } = {}) {
  if (p.status !== 'paused') throw ApiError.conflict('Listing is not paused', 'INVALID_TRANSITION');
  if (p.pause && p.pause.reason === 'admin_review' && !asAdmin) throw ApiError.forbidden('This listing is paused for review; only the admin team can resume it', 'ADMIN_PAUSE');
  const to = p.expiresAt && p.expiresAt > new Date() ? 'live' : 'expired';
  setStatus(p, to, actor, 'Resumed');
  p.pause = undefined;
  p.availability = { ...(p.availability ? p.availability.toObject() : {}), lastConfirmedAt: new Date() };
  await p.save();
  return { status: p.status };
}

async function resume(user, id, req) {
  const p = await ownListing(user, id);
  const out = await resumeListing(p, user._id);
  await ListingCheck.updateMany({ propertyId: p._id, answer: 'none' }, { $set: { answer: 'available', answeredAt: new Date(), answeredVia: 'panel', outcome: 'resumed' } });
  await audit(req, { action: 'listing.resume', entityType: 'Property', entityId: p._id });
  return out;
}

// ---------------------------------------------------------------- "still available?" (A4) and sold elsewhere (A5)

async function applyCheckAnswer(check, p, d, via, actor, req) {
  if (d.answer === 'available') {
    if (p.status === 'paused') await resumeListing(p, actor);
    else { p.availability = { ...(p.availability ? p.availability.toObject() : {}), lastConfirmedAt: new Date() }; await p.save(); }
  } else if (d.answer === 'pause') {
    if (p.status === 'live') {
      setStatus(p, 'paused', actor, d.reason || 'Paused from availability check');
      p.pause = { reason: 'lister', note: d.reason, pausedAt: new Date(), by: actor };
      await p.save();
    }
  } else {
    await soldElsewhere(p, { saleDate: d.saleDate, price: d.price, source: 'check', reason: p.purpose === 'rent' ? 'rented_outside' : 'sold_outside' }, req);
  }
  if (check) {
    Object.assign(check, { answer: d.answer, answeredAt: new Date(), answeredVia: via, saleDate: d.saleDate, price: d.price ? toPaise(d.price) : undefined, outcome: p.status });
    await check.save();
  }
  return { answer: d.answer, listingStatus: p.status };
}

async function answerInPanel(user, id, body, req) {
  const d = v.checkAnswer.parse(body);
  const p = await ownListing(user, id);
  const check = await ListingCheck.findOne({ propertyId: p._id, answer: 'none' }).sort({ createdAt: -1 });
  if (!['live', 'paused'].includes(p.status)) throw ApiError.conflict(`A ${p.status} listing has no availability to confirm`, 'INVALID_TRANSITION');
  return applyCheckAnswer(check, p, d, 'panel', user._id, req);
}

async function checkByToken(token) {
  const check = await ListingCheck.findOne({ tokenHash: sha256(token) });
  if (!check) throw ApiError.notFound('This link is not valid');
  return check;
}

async function checkSummary(token) {
  const check = await checkByToken(token);
  const p = await Property.findById(check.propertyId).select('listingNo title status location.locality location.city media.photos').lean();
  const cover = p && (p.media.photos.find((x) => x.isCover) || p.media.photos[0]);
  return { listingNo: p.listingNo, title: p.title, locality: p.location && p.location.locality, status: p.status, cover: cover && cover.thumbUrl, dueBy: check.dueBy, answered: check.answer !== 'none', answer: check.answer };
}

async function answerByToken(token, body, req) {
  const d = v.checkAnswer.parse(body);
  const check = await checkByToken(token);
  if (check.answer !== 'none') throw ApiError.conflict('This link was already used', 'ALREADY_ANSWERED');
  const p = await Property.findById(check.propertyId);
  if (!['live', 'paused'].includes(p.status)) throw ApiError.conflict(`The listing is ${p.status}`, 'INVALID_TRANSITION');
  return applyCheckAnswer(check, p, d, 'sms', p.listerId, req);
}

async function soldElsewhere(p, { saleDate, price, source, reason }, req) {
  if (saleDate > new Date() || (p.liveAt && saleDate < new Date(p.liveAt.getTime() - 86400000))) throw ApiError.validation([{ in: 'body', path: 'saleDate', message: 'Sale date must be between the live date and today' }]);
  if (await dealUnderVerification(p._id)) throw ApiError.conflict('A deal is under verification for this listing; the admin team will decide', 'DEAL_PENDING');
  setStatus(p, 'inactive', req.user ? req.user._id : p.listerId, reason);
  p.inactiveReason = reason;
  p.soldOutsideDate = saleDate;
  await p.save();
  const { Lead, SiteVisit, Offer } = require('../leads/models');
  const since = new Date(Date.now() - daysMs(await settings.get('listing.soldElsewhereLookbackDays')));
  const months = await settings.get('agreement.nonCircumventionMonths');
  const leads = await Lead.find({ $or: [{ propertyId: p._id }, { linkedProperties: p._id }], lastActivityAt: { $gt: since } }).select('_id stage lastActivityAt').lean();
  const visits = await SiteVisit.find({ propertyId: p._id, status: 'completed', scheduledAt: { $gt: since } }).select('_id').lean();
  const offers = await Offer.find({ propertyId: p._id, createdAt: { $gt: since } }).select('_id').lean();
  // Priority: a platform buyer whose last contact on this property is inside the non-circumvention window.
  const windowStart = new Date(new Date(saleDate).setMonth(new Date(saleDate).getMonth() - months));
  const priority = leads.some((l) => l.lastActivityAt >= windowStart) || visits.length > 0 || offers.length > 0;
  const check = await SoldElsewhereCheck.create({
    checkNo: await counters.soldElsewhereNo(), propertyId: p._id, listerId: p.listerId, source, saleDate, price: price ? toPaise(price) : undefined,
    matches: { leads: leads.filter((l) => ['negotiation', 'booking', 'site_visit_done'].includes(l.stage) || l.lastActivityAt >= windowStart).map((l) => l._id), visits: visits.map((x) => x._id), offers: offers.map((x) => x._id) },
    priority,
  });
  await notifyPermission('receivables.manage', 'listing.sold_outside', { listingNo: p.listingNo, checkNo: check.checkNo, saleDate: fmtDate(saleDate), priority: priority ? 'yes' : 'no', checkId: String(check._id) }, ['in_app', 'email']);
  await audit(req, { action: 'listing.sold_elsewhere', entityType: 'Property', entityId: p._id, after: { checkNo: check.checkNo, priority } });
  return { status: p.status, soldElsewhereCheck: { _id: check._id, checkNo: check.checkNo, priority } };
}

// ---------------------------------------------------------------- admin: sold-elsewhere checks (RE-A-19)

function listSoldElsewhere(query) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.priority) filter.priority = query.priority === 'true';
  return paginate(SoldElsewhereCheck, filter, { ...query, sort: query.sort || '-priority -createdAt' }, { populate: [{ path: 'propertyId', select: 'listingNo title' }, { path: 'listerId', select: 'name email' }] });
}

async function decideSoldElsewhere(id, body, req) {
  const { z } = require('zod');
  const d = z.object({
    assignee: z.string().regex(/^[a-f0-9]{24}$/).optional(),
    status: z.enum(['no_claim', 'claim_raised', 'closed']).optional(),
    claimAmount: z.number().positive().optional(),
    note: z.string().trim().max(1000).optional(),
  }).parse(body);
  const c = await SoldElsewhereCheck.findById(id);
  if (!c) throw ApiError.notFound('Check not found');
  if (d.assignee) c.assignee = d.assignee;
  if (d.status) {
    if (d.status !== 'closed' && !d.note) throw ApiError.validation([{ in: 'body', path: 'note', message: 'A note is required for the decision' }]);
    Object.assign(c, { status: d.status, decidedBy: req.user._id, decidedAt: new Date() });
  }
  if (d.claimAmount) c.claimAmount = toPaise(d.claimAmount);
  if (d.note) c.note = d.note;
  await c.save();
  await audit(req, { action: 'sold_elsewhere.update', entityType: 'SoldElsewhereCheck', entityId: c._id, after: d });
  return c;
}

// ---------------------------------------------------------------- scheduled jobs (A3, A4)

const tokenLink = (token) => `${env.CLIENT_URL.replace(/\/$/, '')}/listing-check/${token}`;

async function createCheck(p, trigger, now) {
  const token = crypto.randomBytes(24).toString('base64url');
  const dueBy = new Date(now.getTime() + daysMs(await settings.get('listing.availabilityReplyDays')));
  const check = await ListingCheck.create({ propertyId: p._id, listerId: p.listerId, trigger, tokenHash: sha256(token), sentAt: now, dueBy, channels: ['sms', 'email', 'in_app'] });
  p.availability = { ...(p.availability ? p.availability.toObject() : {}), lastCheckAt: now, openCheckId: check._id };
  await p.save();
  const lister = await User.findById(p.listerId);
  await notifyUser({ user: lister, event: 'listing.availability_check', channels: ['sms', 'email', 'in_app'], vars: { listingNo: p.listingNo, title: p.title, link: tokenLink(token), dueBy: fmtDate(dueBy), propertyId: String(p._id) } });
  return { check, token };
}

/**
 * Daily freshness job (run at any time; idempotent per day):
 *  - expire live / paused listings past expiresAt
 *  - create "still available?" checks at day 30 and 7 / 1 days before expiry
 *  - remind after 4 days, auto-pause at dueBy without a reply
 */
async function runFreshness(now = new Date()) {
  const s = await settings.all();
  const out = { expired: 0, checks: 0, reminders: 0, autoPaused: 0 };

  for (const p of await Property.find({ status: { $in: ['live', 'paused'] }, expiresAt: { $lte: now } })) {
    setStatus(p, 'expired', undefined, 'Expired');
    await p.save();
    const lister = await User.findById(p.listerId);
    await notifyUser({ user: lister, event: 'listing.expired', channels: ['in_app', 'email'], vars: { listingNo: p.listingNo, title: p.title, propertyId: String(p._id) } });
    out.expired += 1;
  }

  const live = await Property.find({ status: 'live' });
  for (const p of live) {
    if (await ListingCheck.exists({ propertyId: p._id, answer: 'none', dueBy: { $gt: now } })) continue; // one open check per listing
    if (p.availability && p.availability.lastConfirmedAt && now - p.availability.lastConfirmedAt < daysMs(7)) continue;
    const since = (p.availability && p.availability.lastConfirmedAt) || p.liveAt;
    const age = Math.floor((now - since) / 86400000);
    const toExpiry = p.expiresAt ? Math.ceil((p.expiresAt - now) / 86400000) : null;
    let trigger = null;
    if (s['listing.availabilityCheckDays'].includes(age)) trigger = 'day30';
    else if (toExpiry !== null && s['listing.expiryReminderDays'].includes(toExpiry)) trigger = toExpiry === 1 ? 'expiry1' : 'expiry7';
    if (!trigger) continue;
    if (await ListingCheck.exists({ propertyId: p._id, trigger, createdAt: { $gt: new Date(now - daysMs(2)) } })) continue;
    await createCheck(p, trigger, now);
    out.checks += 1;
  }

  const open = await ListingCheck.find({ answer: 'none' });
  for (const c of open) {
    const p = await Property.findById(c.propertyId);
    if (!p || p.status !== 'live') continue;
    if (now >= c.dueBy) {
      if (!s['listing.autoPauseOnNoReply']) continue;
      setStatus(p, 'paused', undefined, 'No reply to availability check');
      p.pause = { reason: 'no_reply', pausedAt: now };
      await p.save();
      c.outcome = 'auto_paused';
      await c.save();
      const lister = await User.findById(p.listerId);
      await notifyUser({ user: lister, event: 'listing.auto_paused', channels: ['sms', 'email', 'in_app'], vars: { listingNo: p.listingNo, link: `${env.CLIENT_URL.replace(/\/$/, '')}/lister/listings/${p._id}`, propertyId: String(p._id) } });
      out.autoPaused += 1;
    } else if (!c.reminderSentAt && now - c.sentAt >= daysMs(s['listing.availabilityReminderAfterDays'])) {
      c.reminderSentAt = now;
      await c.save();
      const lister = await User.findById(p.listerId);
      await notifyUser({ user: lister, event: 'listing.availability_reminder', channels: ['sms', 'in_app'], vars: { listingNo: p.listingNo, dueBy: fmtDate(c.dueBy), link: `${env.CLIENT_URL.replace(/\/$/, '')}/lister/listings/${p._id}`, propertyId: String(p._id) } });
      out.reminders += 1;
    }
  }
  return out;
}

// Drafts untouched for listing.draftPurgeDays are archived (soft-deleted).
async function archiveStaleDrafts(now = new Date()) {
  const days = await settings.get('listing.draftPurgeDays');
  const r = await Property.updateMany({ status: 'draft', deletedAt: null, updatedAt: { $lt: new Date(now - daysMs(days)) } }, { $set: { deletedAt: now } });
  return r.modifiedCount;
}

// Approximate public pin: a deterministic 300-500 m offset per listing (B-04).
async function publicPoint(p) {
  const s = await settings.all();
  if (s['public.locationPrecision'] === 'exact') return p.location.geo;
  const seed = parseInt(sha256(String(p._id)).slice(0, 8), 16);
  const dist = s['public.approxMinMeters'] + (seed % 1000) / 1000 * (s['public.approxMaxMeters'] - s['public.approxMinMeters']);
  const bearing = ((seed >> 10) % 360) * (Math.PI / 180);
  const [lng, lat] = p.location.geo.coordinates;
  const dLat = (dist * Math.cos(bearing)) / 111320;
  const dLng = (dist * Math.sin(bearing)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return toPoint(lat + dLat, lng + dLng);
}

module.exports = {
  createDraft, listOwn, getOwn, saveStep, addMedia, editMedia, orderMedia, removeMedia, currentTemplate, acceptCommission,
  submit, withdraw, renew, deactivate, reactivate, duplicate, softDelete, pause, resume, resumeListing, answerInPanel,
  checkSummary, answerByToken, soldElsewhere, listSoldElsewhere, decideSoldElsewhere, runFreshness, archiveStaleDrafts,
  createCheck, publicPoint, setStatus, missingForSubmit, expiryDaysFor, applyStep, linkProject, inheritFromProject, projectSummary,
};
