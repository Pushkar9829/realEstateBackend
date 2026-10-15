// Module G - builder projects (lister panel, builder accounts only).
const { asyncHandler, ok, created } = require('../../../core/http');
const projects = require('../service');

const run = (fn, status = 200) => asyncHandler(async (req, res) => { const d = await fn(req); return status === 201 ? created(res, d) : ok(res, d); });

module.exports = {
  ownProjects: asyncHandler(async (req, res) => { const { items, meta } = await projects.listOwn(req.user, req.query); ok(res, items, meta); }),
  create: run((req) => projects.create(req.user, req.body, req), 201),
  detail: run((req) => projects.ownProject(req.user, req.params.id)),
  saveTab: run((req) => projects.saveTab(req.user, req.params.id, req.params.tab, req.body, req)), // tabs: details, location, configurations, amenities, rera
  upload: run((req) => projects.addMedia(req.user, req.params.id, req.body), 201),
  acceptAgreement: run((req) => projects.acceptAgreement(req.user, req.params.id, req.body, req)),
  submit: run((req) => projects.submit(req.user, req.params.id, req)),
  updateUnits: run((req) => projects.updateInventory(req.user, req.params.id, req.body, req)),
  csvTemplate: (req, res) => { res.type('text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="units-template.csv"'); res.send(projects.unitsTemplate()); },
  uploadCsvGetPreview: run((req) => projects.importPreview(req.user, req.params.id, req.body, req)), // { csv } or { fileId }
  savePreviewedRows: run((req) => projects.importConfirm(req.user, req.params.id, req.params.importId, req)),
  unitInventoryList: asyncHandler(async (req, res) => { const { items, meta } = await projects.listUnits(req.user, req.params.id, req.query); ok(res, items, meta); }),
};
