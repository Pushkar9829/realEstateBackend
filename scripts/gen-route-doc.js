// Generates ../docs/API_ROUTES.md (endpoint catalogue grouped by panel and
// module) straight from the mounted routers, so the document never drifts.
//   node scripts/gen-route-doc.js
process.env.JOBS_ENABLED = 'false';
const fs = require('fs');
const path = require('path');
const listRoutes = require('../src/core/http/listRoutes');
const { PANELS } = require('../src/panels');

const PANEL_TITLES = {
  integrations: 'Provider webhooks',
  public: 'Public portal (guests, buyers, shared account endpoints)',
  lister: 'Lister panel (owners, builders, landlords)',
  agent: 'Sales agent panel (CRM)',
  admin: 'Admin panel (admin staff and team managers)',
};
const GUARDS = {
  integrations: 'Signature verified per provider',
  public: 'Public, optional login, buyer login or token link per route',
  lister: 'Login + role lister; builder-only routes check listerType',
  agent: 'Login + role agent or manager; permission keys where noted',
  admin: 'Login + admin / superadmin / manager + permission key per route',
};

const rows = listRoutes();
const out = ['# Real Estate API - Endpoint Catalogue', '',
  `Generated from the mounted routers on ${new Date().toISOString().slice(0, 10)}. ${rows.length} endpoints. Status "built" = implemented; "designed" = routed and guarded, answers 501 until its module milestone.`, ''];

out.push('## Summary by panel', '', '| Panel | Mount | Guard | Endpoints |', '|---|---|---|---|');
Object.keys(PANEL_TITLES).forEach((p) => {
  out.push(`| ${PANEL_TITLES[p]} | ${PANELS[p].mount} | ${GUARDS[p]} | ${rows.filter((r) => r.panel === p).length} |`);
});
out.push('');

Object.keys(PANEL_TITLES).forEach((panel) => {
  const pr = rows.filter((r) => r.panel === panel);
  if (!pr.length) return;
  out.push(`## ${PANEL_TITLES[panel]} (${PANELS[panel].mount})`, '');
  [...new Set(pr.map((r) => r.module))].sort().forEach((mod) => {
    out.push(`### Module ${mod}`, '', '| Method | Path | Status |', '|---|---|---|');
    pr.filter((r) => r.module === mod).forEach((r) => out.push(`| ${r.method} | \`${r.path}\` | ${r.implemented ? 'built' : 'designed'} |`));
    out.push('');
  });
});

const target = path.resolve(__dirname, '../../docs/API_ROUTES.md');
fs.writeFileSync(target, out.join('\n'));
console.log(`Wrote ${target} (${rows.length} endpoints)`);
