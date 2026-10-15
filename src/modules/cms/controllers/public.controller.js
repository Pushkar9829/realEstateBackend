// Module L - public pages and sitemap (RE-L-05, RE-L-09).
const { asyncHandler, ok, ApiError } = require('../../../core/http');
const { Page, Master } = require('../models');
const env = require('../../../config/env');

module.exports = {
  // GET /api/pages/:slug - published pages only
  page: asyncHandler(async (req, res) => {
    const page = await Page.findOne({ slug: req.params.slug, status: 'published' }).select('slug title content meta publishedAt updatedAt').lean();
    if (!page) throw ApiError.notFound('Page not found');
    ok(res, page);
  }),

  // GET /api/sitemap.xml - static pages and city / locality landing pages.
  // Listing and project URLs are added when the public portal ships (Phase 3).
  sitemap: asyncHandler(async (req, res) => {
    const base = env.CLIENT_URL.replace(/\/$/, '');
    const [pages, cities, localities] = await Promise.all([
      Page.find({ status: 'published' }).select('slug updatedAt').lean(),
      Master.find({ type: 'city', active: true }).select('slug updatedAt').lean(),
      Master.find({ type: 'locality', active: true, mergedInto: null }).select('slug parentId updatedAt').lean(),
    ]);
    const cityById = Object.fromEntries(cities.map((c) => [String(c._id), c.slug]));
    const urls = [
      { loc: `${base}/`, lastmod: new Date() },
      ...pages.map((p) => ({ loc: `${base}/p/${p.slug}`, lastmod: p.updatedAt })),
      ...cities.map((c) => ({ loc: `${base}/property-in-${c.slug}`, lastmod: c.updatedAt })),
      ...localities.filter((l) => cityById[String(l.parentId)]).map((l) => ({ loc: `${base}/property-in-${cityById[String(l.parentId)]}/${l.slug}`, lastmod: l.updatedAt })),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${u.loc}</loc><lastmod>${new Date(u.lastmod).toISOString().slice(0, 10)}</lastmod></url>`).join('\n')}\n</urlset>\n`;
    res.type('application/xml').send(xml);
  }),
};
