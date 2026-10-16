// Module L - public pages and SEO assets (RE-L-05, RE-L-09).
const { asyncHandler, ok, ApiError } = require('../../../core/http');
const { Page, Master } = require('../models');
const env = require('../../../config/env');

// The sitemap protocol allows 50,000 URLs per file; above that /sitemap.xml
// becomes a sitemap index of /sitemap-<n>.xml parts. Tests lower this limit.
const limits = { maxUrls: 50000 };

const trim = (u) => String(u || '').replace(/\/+$/, '');
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const day = (d) => { const t = d ? new Date(d) : null; return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(0, 10) : null; };
const seg = (s) => encodeURIComponent(String(s));

// Every public URL, using the frontend's real route patterns (frontend/src/panels/public/routes.jsx).
async function sitemapUrls() {
  // Required here, not at the top, so the CMS module does not load the listing / project modules at boot.
  const { Property } = require('../../listings/models');
  const { Project } = require('../../projects/models');
  const base = trim(env.CLIENT_URL);
  const [pages, cities, localities, listings, projects] = await Promise.all([
    Page.find({ status: 'published' }).select('slug updatedAt').lean(),
    Master.find({ type: 'city', active: true }).select('code slug updatedAt').sort({ sort: 1, name: 1 }).lean(),
    Master.find({ type: 'locality', active: true, mergedInto: null }).select('code slug parentId updatedAt').lean(),
    Property.find({ status: 'live', deletedAt: null, slug: { $nin: [null, ''] } }).select('slug updatedAt liveAt').sort({ liveAt: -1 }).lean(),
    Project.find({ status: { $in: ['live', 'sold_out'] }, slug: { $nin: [null, ''] } }).select('slug updatedAt').sort({ updatedAt: -1 }).lean(),
  ]);
  const cityCode = Object.fromEntries(cities.map((c) => [String(c._id), c.code || c.slug]));
  const latest = (rows) => rows.reduce((m, r) => (r.updatedAt && (!m || r.updatedAt > m) ? r.updatedAt : m), null);
  const lastListing = latest(listings);
  const lastProject = latest(projects);
  const u = (path, lastmod) => ({ loc: `${base}${path}`, lastmod });

  return [
    u('/', lastListing || new Date()),
    u('/search?purpose=sale', lastListing),
    u('/search?purpose=rent', lastListing),
    u('/projects', lastProject),
    u('/tools/calculators'),
    u('/list-your-property'),
    u('/request-property'),
    u('/contact'),
    ...pages.map((p) => u(`/p/${seg(p.slug)}`, p.updatedAt)),
    ...cities.flatMap((c) => {
      const code = seg(c.code || c.slug);
      return [
        u(`/city/${code}`, c.updatedAt),
        u(`/city/${code}/localities`, c.updatedAt),
        u(`/search?purpose=sale&city=${code}`, lastListing),
        u(`/search?purpose=rent&city=${code}`, lastListing),
      ];
    }),
    ...localities.filter((l) => cityCode[String(l.parentId)]).map((l) => u(`/city/${seg(cityCode[String(l.parentId)])}/${seg(l.code || l.slug)}`, l.updatedAt)),
    ...listings.map((p) => u(`/property/${seg(p.slug)}`, p.updatedAt || p.liveAt)),
    ...projects.map((p) => u(`/projects/${seg(p.slug)}`, p.updatedAt)),
  ];
}

function urlset(urls) {
  const rows = urls.map((x) => {
    const lm = day(x.lastmod);
    return `  <url><loc>${xmlEscape(x.loc)}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

function sitemapIndex(parts) {
  const api = trim(env.API_PUBLIC_URL);
  const rows = parts.map((chunk, i) => {
    const lm = day(chunk.reduce((m, x) => (x.lastmod && (!m || new Date(x.lastmod) > new Date(m)) ? x.lastmod : m), null));
    return `  <sitemap><loc>${xmlEscape(`${api}/api/sitemap-${i + 1}.xml`)}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}</sitemap>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</sitemapindex>\n`;
}

function chunks(urls) {
  const size = Math.max(1, limits.maxUrls);
  const out = [];
  for (let i = 0; i < urls.length; i += size) out.push(urls.slice(i, i + size));
  return out;
}

const sendXml = (res, xml) => res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(xml);

module.exports = {
  limits,

  // GET /api/pages/:slug - published pages only
  page: asyncHandler(async (req, res) => {
    const page = await Page.findOne({ slug: req.params.slug, status: 'published' }).select('slug title content meta publishedAt updatedAt').lean();
    if (!page) throw ApiError.notFound('Page not found');
    ok(res, page);
  }),

  // GET /api/sitemap.xml - one urlset, or a sitemap index when there are more than 50,000 URLs.
  sitemap: asyncHandler(async (req, res) => {
    const urls = await sitemapUrls();
    sendXml(res, urls.length <= limits.maxUrls ? urlset(urls) : sitemapIndex(chunks(urls)));
  }),

  // GET /api/sitemap-:part.xml - one part of the sitemap index (1-based).
  sitemapPart: asyncHandler(async (req, res) => {
    const n = /^\d{1,4}$/.test(req.params.part) ? Number(req.params.part) : 0;
    const parts = chunks(await sitemapUrls());
    if (n < 1 || n > parts.length) throw ApiError.notFound('Sitemap part not found', 'SITEMAP_PART_NOT_FOUND');
    sendXml(res, urlset(parts[n - 1]));
  }),

  // GET /api/robots.txt - crawl rules for the public site (RE-L-09, SPEC section 9).
  robots: asyncHandler(async (req, res) => {
    const disallow = ['/lister', '/agent', '/admin', '/account', '/shortlist', '/my-enquiries', '/compare',
      '/login', '/register', '/verify', '/forgot-password', '/visit/', '/feedback/', '/visit-feedback/', '/listing-check/', '/verify-photos/', '/alerts/'];
    const body = ['User-agent: *', 'Allow: /', ...disallow.map((p) => `Disallow: ${p}`), '', `Sitemap: ${trim(env.API_PUBLIC_URL)}/api/sitemap.xml`, ''].join('\n');
    res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(body);
  }),
};
