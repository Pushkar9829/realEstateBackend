// Phase 8 - public SEO assets (RE-L-09): sitemap.xml with the frontend's real
// URL patterns, the sitemap index above the URL limit, and robots.txt.
const request = require('supertest');
const mongoose = require('mongoose');
const h = require('../helpers');
const env = require('../../src/config/env');
const { Page, Master } = require('../../src/modules/cms/models');
const { Property } = require('../../src/modules/listings/models');
const { Project } = require('../../src/modules/projects/models');
const cms = require('../../src/modules/cms/controllers/public.controller');

let app;
const base = env.CLIENT_URL.replace(/\/$/, '');
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

beforeAll(async () => {
  app = await h.setup();
  const pune = await Master.create({ type: 'city', code: 'pune', slug: 'pune', name: 'Pune' });
  await Master.create({ type: 'city', code: 'goa', slug: 'goa', name: 'Goa', active: false });
  const wakad = await Master.create({ type: 'locality', code: 'wakad', slug: 'wakad', name: 'Wakad', parentId: pune._id });
  await Master.create({ type: 'locality', code: 'old-wakad', slug: 'old-wakad', name: 'Old Wakad', parentId: pune._id, mergedInto: wakad._id });
  await Page.create([
    { slug: 'about', title: 'About us', status: 'published' },
    { slug: 'secret-draft', title: 'Draft', status: 'draft' },
  ]);
  const now = new Date();
  const listing = (slug, status, extra = {}) => ({ slug, status, purpose: 'sale', listingNo: slug.toUpperCase(), deletedAt: null, liveAt: now, updatedAt: new Date('2026-09-15T10:00:00Z'), createdAt: now, ...extra });
  await Property.collection.insertMany([
    listing('2-bhk-wakad-ab12', 'live'),
    listing('pending-one', 'pending_review'),
    listing('removed-one', 'live', { deletedAt: now }),
  ]);
  await Project.collection.insertMany([
    { projectNo: 'PRJ-T1', slug: 'skyline-heights', status: 'live', name: 'Skyline Heights', updatedAt: new Date('2026-09-20T10:00:00Z'), createdAt: now },
    { projectNo: 'PRJ-T2', slug: 'gone-towers', status: 'sold_out', name: 'Gone Towers', updatedAt: now, createdAt: now },
    { projectNo: 'PRJ-T3', slug: 'draft-towers', status: 'draft', name: 'Draft Towers', updatedAt: now, createdAt: now },
  ]);
});
afterAll(() => mongoose.disconnect());
afterEach(() => { cms.limits.maxUrls = 50000; });

describe('[L][public] RE-L-09 sitemap.xml', () => {
  test('is a valid urlset of absolute CLIENT_URL links using the frontend URL patterns', async () => {
    const res = await request(app).get('/api/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(res.text).toMatch(/<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    expect(res.text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/); // XML-escaped
    const urls = locs(res.text);
    urls.forEach((u) => expect(u.startsWith(`${base}/`)).toBe(true));
    urls.forEach((u) => expect(() => new URL(u)).not.toThrow());
    expect(new Set(urls).size).toBe(urls.length);
    const paths = urls.map((u) => u.slice(base.length));
    expect(paths).toEqual(expect.arrayContaining([
      '/', '/projects', '/tools/calculators', '/search?purpose=sale', '/search?purpose=rent',
      '/city/pune', '/city/pune/localities', '/city/pune/wakad', '/search?purpose=sale&city=pune',
      '/p/about', '/property/2-bhk-wakad-ab12', '/projects/skyline-heights', '/projects/gone-towers',
    ]));
    // Never: old URL patterns, drafts, inactive or merged masters, non-live or deleted listings.
    expect(res.text).not.toMatch(/property-in-/);
    ['/p/secret-draft', '/city/goa', '/city/pune/old-wakad', '/property/pending-one', '/property/removed-one', '/projects/draft-towers']
      .forEach((p) => expect(paths).not.toContain(p));
  });

  test('live listings and projects carry their lastmod date', async () => {
    const res = await request(app).get('/api/sitemap.xml');
    expect(res.text).toMatch(/\/property\/2-bhk-wakad-ab12<\/loc><lastmod>2026-09-15<\/lastmod>/);
    expect(res.text).toMatch(/\/projects\/skyline-heights<\/loc><lastmod>2026-09-20<\/lastmod>/);
    (res.text.match(/<lastmod>[^<]*<\/lastmod>/g) || []).forEach((l) => expect(l).toMatch(/^<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>$/));
  });

  test('above the URL limit it becomes a sitemap index whose parts hold every URL once', async () => {
    const all = locs((await request(app).get('/api/sitemap.xml')).text);
    cms.limits.maxUrls = 5;
    const idx = await request(app).get('/api/sitemap.xml');
    expect(idx.text).toMatch(/<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const parts = locs(idx.text);
    expect(parts.length).toBe(Math.ceil(all.length / 5));
    const seen = [];
    for (const p of parts) {
      const path = new URL(p).pathname;
      expect(path).toMatch(/^\/api\/sitemap-\d+\.xml$/);
      const part = await request(app).get(path);
      expect(part.status).toBe(200);
      expect(part.text).toMatch(/<urlset /);
      const u = locs(part.text);
      expect(u.length).toBeLessThanOrEqual(5);
      seen.push(...u);
    }
    expect(seen).toEqual(all);
    expect((await request(app).get(`/api/sitemap-${parts.length + 1}.xml`)).status).toBe(404);
    expect((await request(app).get('/api/sitemap-0.xml')).status).toBe(404);
  });
});

describe('[L][public] RE-L-09 robots.txt', () => {
  test('allows the public site, blocks panels, account areas and token links, and points at the sitemap', async () => {
    const res = await request(app).get('/api/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('User-agent: *');
    ['/lister', '/agent', '/admin', '/account', '/verify-photos/', '/listing-check/', '/feedback/']
      .forEach((p) => expect(lines).toContain(`Disallow: ${p}`));
    expect(lines).not.toContain('Disallow: /property');
    expect(lines).not.toContain('Disallow: /');
    const sm = lines.find((l) => l.startsWith('Sitemap: '));
    expect(sm).toBe(`Sitemap: ${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/sitemap.xml`);
  });
});

describe('[S][public] RE-L-05 Default footer pages', () => {
  test('the seed text covers every footer page and the pages are served once published', async () => {
    const { Page } = require('../../src/modules/cms/models');
    const DEFAULT_PAGES = require('../../scripts/default-pages');
    expect(DEFAULT_PAGES.map((p) => p.slug).sort()).toEqual(['about', 'careers', 'faq', 'no-broker-policy', 'privacy', 'terms']);
    for (const p of DEFAULT_PAGES) {
      expect(p.content.length).toBeGreaterThan(200);
      expect(p.description.length).toBeLessThanOrEqual(160);
    }
    const about = DEFAULT_PAGES[0];
    await Page.updateOne({ slug: `seedcheck-${about.slug}` }, { $set: { title: about.title, content: about.content, status: 'published', publishedAt: new Date() } }, { upsert: true });
    const r = await request(app).get(`/api/pages/seedcheck-${about.slug}`).expect(200);
    expect(r.body.data.content).toMatch(/no-broker|brokers/i);
  });
});
