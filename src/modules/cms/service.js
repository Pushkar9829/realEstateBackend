// Module L - CMS & Masters (RE-L-01..10). Masters live in one collection with
// a `type`; URLs use plural names (/masters/cities, /masters/property-types).
const { z } = require('zod');
const { Master, Page, Banner, Faq, Testimonial, AgreementTemplate } = require('./models');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { toPoint } = require('../../core/geo');
const settings = require('../../core/settings');

const TYPE_BY_PATH = {
  cities: 'city', localities: 'locality', 'property-types': 'property_type', amenities: 'amenity',
  'landmark-types': 'landmark_type', reasons: 'reason', 'doc-types': 'doc_type',
};
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function typeFromPath(pathType) {
  const t = TYPE_BY_PATH[pathType];
  if (!t) throw ApiError.notFound(`Unknown master "${pathType}"`, 'UNKNOWN_MASTER');
  return t;
}

const masterInput = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,40}$/).optional(),
  parentId: z.string().regex(/^[a-f0-9]{24}$/).optional(), // locality -> city
  state: z.string().trim().max(60).optional(),
  lat: z.coerce.number().min(6).max(37).optional(),
  lng: z.coerce.number().min(68).max(98).optional(),
  pincodes: z.array(z.string().regex(/^[1-9][0-9]{5}$/)).max(50).optional(),
  aliases: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
  category: z.string().max(40).optional(),
  group: z.string().max(40).optional(),
  icon: z.string().max(40).optional(),
  appliesTo: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  fieldProfile: z.record(z.any()).optional(),
  active: z.boolean().optional(),
});

function toMasterDoc(type, d) {
  const meta = {};
  ['state', 'pincodes', 'aliases', 'category', 'group', 'icon', 'appliesTo', 'required', 'fieldProfile'].forEach((k) => { if (d[k] !== undefined) meta[k] = d[k]; });
  if (d.lat !== undefined && d.lng !== undefined) meta.centroid = toPoint(d.lat, d.lng);
  const doc = { type, name: d.name, ...(d.active !== undefined ? { active: d.active } : {}) };
  if (d.parentId) doc.parentId = d.parentId;
  return { doc, meta };
}

async function listMaster(pathType, query) {
  const type = typeFromPath(pathType);
  const filter = { type, mergedInto: null };
  if (type === 'locality') {
    if (query.cityId) filter.parentId = query.cityId;
    if (query.requests === 'pending') filter['request.status'] = 'pending';
  }
  if (query.active !== undefined) filter.active = query.active === 'true';
  if (query.q) filter.name = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return paginate(Master, filter, { ...query, sort: query.sort || 'sort' }, { maxLimit: 500 });
}

async function createMaster(pathType, body, req) {
  const type = typeFromPath(pathType);
  const d = masterInput.parse(body);
  if (type === 'locality') {
    if (!d.parentId || !(await Master.exists({ _id: d.parentId, type: 'city' }))) throw ApiError.validation([{ in: 'body', path: 'parentId', message: 'A locality needs its city' }]);
    if (d.lat === undefined) throw ApiError.validation([{ in: 'body', path: 'lat', message: 'Locality centroid (lat, lng) is required' }]);
  }
  const { doc, meta } = toMasterDoc(type, d);
  const code = d.code || slugify(d.name).replace(/-/g, type === 'locality' || type === 'city' ? '-' : '_');
  if (await Master.exists({ type, code })) throw ApiError.conflict(`Code "${code}" already exists`, 'DUPLICATE');
  const count = await Master.countDocuments({ type });
  const created = await Master.create({ ...doc, code, slug: slugify(d.name), meta, sort: count });
  await audit(req, { action: 'master.create', entityType: 'Master', entityId: created._id, after: { type, code, name: d.name } });
  return created;
}

async function editMaster(pathType, id, body, req) {
  const type = typeFromPath(pathType);
  const d = masterInput.partial().parse(body);
  delete d.code; // codes are immutable
  const m = await Master.findOne({ _id: id, type });
  if (!m) throw ApiError.notFound('Master item not found');
  const before = m.toObject();
  const { doc, meta } = toMasterDoc(type, { name: m.name, ...d });
  Object.assign(m, doc);
  m.meta = { ...(m.meta ? m.meta.toObject() : {}), ...meta };
  if (d.name) m.slug = slugify(d.name);
  await m.save();
  await audit(req, { action: 'master.edit', entityType: 'Master', entityId: m._id, before: { name: before.name, active: before.active }, after: d });
  return m;
}

async function reorderMaster(pathType, body, req) {
  const type = typeFromPath(pathType);
  const { ids } = z.object({ ids: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(500) }).parse(body);
  await Promise.all(ids.map((id, i) => Master.updateOne({ _id: id, type }, { $set: { sort: i } })));
  await audit(req, { action: 'master.reorder', entityType: 'Master', after: { type, count: ids.length } });
  return { reordered: ids.length };
}

// CSV import of localities: "city_code,name,code,pincodes(;),lat,lng,aliases(;)"
async function importLocalities(csvText, req) {
  const lines = String(csvText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^city/i.test(lines[0])) lines.shift();
  if (lines.length > 2000) throw ApiError.badRequest('Max 2000 rows per import', 'TOO_MANY_ROWS');
  const result = { created: 0, updated: 0, errors: [] };
  for (const [i, line] of lines.entries()) {
    const [cityCode, name, code, pins, lat, lng, aliases] = line.split(',').map((x) => (x || '').trim());
    const city = await Master.findOne({ type: 'city', code: cityCode });
    const parsed = masterInput.safeParse({ name, code: code || undefined, lat, lng, pincodes: pins ? pins.split(';') : undefined, aliases: aliases ? aliases.split(';') : undefined });
    if (!city) { result.errors.push({ line: i + 1, reason: `Unknown city ${cityCode}` }); continue; }
    if (!parsed.success) { result.errors.push({ line: i + 1, reason: parsed.error.issues.map((x) => x.message).join('; ') }); continue; }
    const d = parsed.data;
    const c = d.code || slugify(d.name);
    const meta = { state: city.meta && city.meta.state, pincodes: d.pincodes, aliases: d.aliases, ...(d.lat !== undefined ? { centroid: toPoint(d.lat, d.lng) } : {}) };
    const r = await Master.updateOne({ type: 'locality', code: c }, { $set: { name: d.name, slug: slugify(d.name), parentId: city._id, meta, active: true }, $setOnInsert: { type: 'locality', code: c } }, { upsert: true });
    if (r.upsertedCount) result.created += 1; else result.updated += 1;
  }
  await audit(req, { action: 'master.localities.import', entityType: 'Master', after: { created: result.created, updated: result.updated, errors: result.errors.length } });
  return result;
}

// Merge a duplicate locality into another; the source becomes an alias.
async function mergeLocality(id, body, req) {
  const { intoId } = z.object({ intoId: z.string().regex(/^[a-f0-9]{24}$/) }).parse(body);
  if (id === intoId) throw ApiError.badRequest('Cannot merge a locality into itself');
  const [src, dst] = await Promise.all([Master.findOne({ _id: id, type: 'locality' }), Master.findOne({ _id: intoId, type: 'locality' })]);
  if (!src || !dst) throw ApiError.notFound('Locality not found');
  dst.meta = { ...(dst.meta ? dst.meta.toObject() : {}), aliases: [...new Set([...((dst.meta && dst.meta.aliases) || []), src.name, ...((src.meta && src.meta.aliases) || [])])] };
  await dst.save();
  src.active = false;
  src.mergedInto = dst._id;
  await src.save();
  // Listings are moved to the surviving locality from Phase 2 on (properties.location.localityId).
  const { Property } = require('../listings/models');
  const moved = await Property.updateMany({ 'location.localityId': src._id }, { $set: { 'location.localityId': dst._id, 'location.locality': dst.name } });
  await audit(req, { action: 'master.locality.merge', entityType: 'Master', entityId: src._id, after: { into: dst._id, listingsMoved: moved.modifiedCount } });
  return { merged: true, into: dst._id, listingsMoved: moved.modifiedCount };
}

async function decideLocalityRequest(id, body, req) {
  const { decision, reason } = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(300).optional() }).parse(body);
  const m = await Master.findOne({ _id: id, type: 'locality', 'request.status': 'pending' });
  if (!m) throw ApiError.notFound('Pending locality request not found');
  m.request.status = decision === 'approve' ? 'approved' : 'rejected';
  m.request.decidedBy = req.user._id;
  m.request.decidedAt = new Date();
  m.request.reason = reason;
  if (decision === 'approve') m.active = true;
  await m.save();
  if (decision === 'approve' && m.request.propertyId) {
    const { Property } = require('../listings/models');
    await Property.updateOne({ _id: m.request.propertyId }, { $set: { 'location.localityId': m._id, 'location.locality': m.name } });
  }
  await audit(req, { action: `master.locality_request.${decision}`, entityType: 'Master', entityId: m._id, reason });
  return m;
}

// ---------------------------------------------------------------- content

const pageInput = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/),
  title: z.string().trim().min(2).max(120),
  content: z.string().max(100000).default(''),
  meta: z.object({ title: z.string().max(70).optional(), description: z.string().max(160).optional() }).optional(),
  status: z.enum(['draft', 'published']).optional(),
});
const bannerInput = z.object({
  title: z.string().max(120).optional(), imageFileId: z.string().regex(/^[a-f0-9]{24}$/).optional(), imageUrl: z.string().url().optional(),
  link: z.string().max(300).optional(), cities: z.array(z.string()).max(50).optional(),
  startAt: z.coerce.date().optional(), endAt: z.coerce.date().optional(), active: z.boolean().optional(), sort: z.number().int().optional(),
});
const faqInput = z.object({ group: z.string().max(60).optional(), question: z.string().min(5).max(300), answer: z.string().min(2).max(5000), active: z.boolean().optional(), sort: z.number().int().optional() });
const testimonialInput = z.object({ name: z.string().max(80).optional(), city: z.string().max(60).optional(), text: z.string().min(5).max(1000), rating: z.number().min(1).max(5).optional(), active: z.boolean().optional(), sort: z.number().int().optional() });

const crud = (Model, input, entity) => ({
  list: (query) => paginate(Model, {}, { ...query, sort: query.sort || (Model === Page ? 'slug' : 'sort') }),
  get: async (id) => { const d = await Model.findById(id); if (!d) throw ApiError.notFound(`${entity} not found`); return d; },
  create: async (body, req) => {
    const d = await Model.create(input.parse(body));
    await audit(req, { action: `${entity.toLowerCase()}.create`, entityType: entity, entityId: d._id });
    return d;
  },
  update: async (id, body, req) => {
    const data = input.partial().parse(body);
    const d = await Model.findById(id);
    if (!d) throw ApiError.notFound(`${entity} not found`);
    if (Model === Page && data.content !== undefined && data.content !== d.content) {
      // keep the last 10 versions of a page
      d.versions = [{ version: (d.versions.length ? d.versions[0].version : 0) + 1, content: d.content, savedBy: req.user._id, savedAt: new Date() }, ...d.versions].slice(0, 10);
    }
    if (Model === Page && data.status === 'published' && d.status !== 'published') d.publishedAt = new Date();
    Object.assign(d, data);
    await d.save();
    await audit(req, { action: `${entity.toLowerCase()}.update`, entityType: entity, entityId: d._id, after: Object.keys(data) });
    return d;
  },
});

const pages = crud(Page, pageInput, 'Page');
const banners = crud(Banner, bannerInput, 'Banner');
const faqs = crud(Faq, faqInput, 'Faq');
const testimonials = crud(Testimonial, testimonialInput, 'Testimonial');

const HOME_SECTIONS = ['search', 'featured_properties', 'projects', 'localities', 'how_it_works', 'testimonials', 'faqs', 'banners'];
async function setHomeSections(body, req) {
  const { sections } = z.object({ sections: z.array(z.enum(HOME_SECTIONS)).min(1).max(HOME_SECTIONS.length) }).parse(body);
  await settings.set('home.sections', sections, req.user._id);
  await audit(req, { action: 'cms.home_sections', entityType: 'Setting', after: { sections } });
  return { sections };
}

// ---------------------------------------------------------------- agreement templates (RE-L-08)

const NON_CIRCUMVENTION = /\{\{nonCircumventionMonths\}\}/;
const templateInput = z.object({ purpose: z.enum(['sale', 'rent', 'project']), body: z.string().min(100).max(20000) });

const listTemplates = (query) => paginate(AgreementTemplate, query.purpose ? { purpose: query.purpose } : {}, { ...query, sort: '-version' });

async function createTemplate(body, req) {
  const d = templateInput.parse(body);
  const last = await AgreementTemplate.findOne({ purpose: d.purpose }).sort({ version: -1 });
  const t = await AgreementTemplate.create({ ...d, version: (last ? last.version : 0) + 1, status: 'draft' });
  await audit(req, { action: 'agreement_template.create', entityType: 'AgreementTemplate', entityId: t._id, after: { purpose: d.purpose, version: t.version } });
  return t;
}

// Publishing requires the non-circumvention clause and retires the previous
// published version; listings keep the version they accepted.
async function publishTemplate(id, req) {
  const t = await AgreementTemplate.findById(id);
  if (!t) throw ApiError.notFound('Template not found');
  if (t.status !== 'draft') throw ApiError.conflict('Only a draft can be published', 'INVALID_TRANSITION');
  if (!NON_CIRCUMVENTION.test(t.body)) {
    throw ApiError.badRequest('The agreement must contain the non-circumvention clause ({{nonCircumventionMonths}} placeholder)', 'NON_CIRCUMVENTION_MISSING');
  }
  await AgreementTemplate.updateMany({ purpose: t.purpose, status: 'published' }, { $set: { status: 'retired' } });
  t.status = 'published';
  t.publishedAt = new Date();
  t.publishedBy = req.user._id;
  await t.save();
  await audit(req, { action: 'agreement_template.publish', entityType: 'AgreementTemplate', entityId: t._id, after: { purpose: t.purpose, version: t.version } });
  return t;
}

const currentTemplate = (purpose) => AgreementTemplate.findOne({ purpose, status: 'published' }).sort({ version: -1 });

module.exports = {
  TYPE_BY_PATH, listMaster, createMaster, editMaster, reorderMaster, importLocalities, mergeLocality, decideLocalityRequest,
  pages, banners, faqs, testimonials, setHomeSections, listTemplates, createTemplate, publishTemplate, currentTemplate, slugify,
};
