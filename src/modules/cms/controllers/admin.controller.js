// Module L - CMS & Masters: admin panel handlers (names generated from the spec).
const { asyncHandler, ok, created } = require('../../../core/http');
const cms = require('../service');

const list = (fn) => asyncHandler(async (req, res) => { const { items, meta } = await fn(req); ok(res, items, meta); });
const one = (fn, status = 200) => asyncHandler(async (req, res) => {
  const data = await fn(req);
  return status === 201 ? created(res, data) : ok(res, data);
});

module.exports = {
  // masters (RE-L-01..03)
  csvImport: one((req) => cms.importLocalities(req.body.csv, req)), // POST /api/admin/masters/localities/import  { csv }
  merge: one((req) => cms.mergeLocality(req.params.id, req.body, req)), // POST /api/admin/masters/localities/:id/merge
  decideRequest: one((req) => cms.decideLocalityRequest(req.params.id, req.body, req)), // POST /api/admin/masters/locality-requests/:id/decision
  listMaster: list((req) => cms.listMaster(req.params.type, req.query)), // GET /api/admin/masters/:type
  createItem: one((req) => cms.createMaster(req.params.type, req.body, req), 201), // POST /api/admin/masters/:type
  sort: one((req) => cms.reorderMaster(req.params.type, req.body, req)), // PATCH /api/admin/masters/:type/reorder
  editDeactivate: one((req) => cms.editMaster(req.params.type, req.params.id, req.body, req)), // PATCH /api/admin/masters/:type/:id

  // pages, banners, FAQs, testimonials (RE-L-05..07)
  pages: list((req) => cms.pages.list(req.query)),
  pagesDetail: one((req) => cms.pages.get(req.params.id)),
  pagesPost: one((req) => cms.pages.create(req.body, req), 201),
  pagesPatch: one((req) => cms.pages.update(req.params.id, req.body, req)),
  banners: list((req) => cms.banners.list(req.query)),
  bannersDetail: one((req) => cms.banners.get(req.params.id)),
  bannersPost: one((req) => cms.banners.create(req.body, req), 201),
  bannersPatch: one((req) => cms.banners.update(req.params.id, req.body, req)),
  faqs: list((req) => cms.faqs.list(req.query)),
  faqsDetail: one((req) => cms.faqs.get(req.params.id)),
  faqsPost: one((req) => cms.faqs.create(req.body, req), 201),
  faqsPatch: one((req) => cms.faqs.update(req.params.id, req.body, req)),
  testimonials: list((req) => cms.testimonials.list(req.query)),
  testimonialsDetail: one((req) => cms.testimonials.get(req.params.id)),
  testimonialsPost: one((req) => cms.testimonials.create(req.body, req), 201),
  testimonialsPatch: one((req) => cms.testimonials.update(req.params.id, req.body, req)),
  homeLayout: one((req) => cms.setHomeSections(req.body, req)), // PATCH /api/admin/home-sections

  // agreement templates (RE-L-08)
  templates: list((req) => cms.listTemplates(req.query)),
  templatesPost: one((req) => cms.createTemplate(req.body, req), 201),
  publishVersion: one((req) => cms.publishTemplate(req.params.id, req)),
};
