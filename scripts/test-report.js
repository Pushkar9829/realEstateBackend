// Turns a Jest JSON result into a phase test report (markdown) grouped by
// module, panel and feature. Test names follow "[M][panel] FEATURE-ID title".
//   npx jest --runInBand --json --outputFile=report.json
//   node scripts/test-report.js report.json "Phase 1 - Foundation (M1)" ../docs/test-reports/PHASE1.md
const fs = require('fs');
const path = require('path');

const [, , input, title = 'Test report', output] = process.argv;
const result = JSON.parse(fs.readFileSync(input, 'utf8'));

const MODULES = {
  A: 'Property Listing & Catalog', B: 'Identity & Contact Masking', C: 'Lead Management System', D: 'Admin Approval & Operations',
  E: 'Search & Discovery', F: 'Lister KYC & No-Broker', G: 'Builder Projects', H: 'Deals & Receipts', I: 'Receivables & Invoicing',
  J: 'Teams & Territories', K: 'Notifications', L: 'CMS & Masters', M: 'Authentication & Account Security', N: 'MLM Referral & Outbox',
  O: 'Reports, Audit & Logs',
};

const rows = [];
result.testResults.forEach((file) => {
  file.assertionResults.forEach((t) => {
    const group = t.ancestorTitles.join(' > ');
    const m = group.match(/^\[([A-O])\]\[(\w+)\]\s*(.*)$/);
    rows.push({
      module: m ? m[1] : 'Infra',
      panel: m ? m[2] : 'infrastructure',
      feature: m ? m[3] : group || path.basename(file.name),
      test: t.title,
      status: t.status,
      ms: t.duration || 0,
      file: path.basename(file.name),
    });
  });
});

const passed = rows.filter((r) => r.status === 'passed').length;
const failed = rows.filter((r) => r.status === 'failed').length;
const out = [`# ${title}`, '',
  `Run on ${new Date(result.startTime).toISOString().slice(0, 16).replace('T', ' ')} UTC against a local MongoDB test database (never production). ${result.numTotalTestSuites} suites, ${rows.length} tests: **${passed} passed**, **${failed} failed**.`, '',
  '## Summary by module', '', '| Module | Panels | Tests | Passed |', '|---|---|---|---|'];
const byModule = {};
rows.forEach((r) => { (byModule[r.module] = byModule[r.module] || []).push(r); });
Object.keys(byModule).sort().forEach((m) => {
  const list = byModule[m];
  out.push(`| ${m === 'Infra' ? 'Architecture & core' : `${m} ${MODULES[m]}`} | ${[...new Set(list.map((r) => r.panel))].join(', ')} | ${list.length} | ${list.filter((r) => r.status === 'passed').length} |`);
});
out.push('');

Object.keys(byModule).sort().forEach((m) => {
  out.push(`## ${m === 'Infra' ? 'Architecture & core' : `Module ${m} - ${MODULES[m]}`}`, '');
  const byFeature = {};
  byModule[m].forEach((r) => { (byFeature[`${r.panel}|${r.feature}`] = byFeature[`${r.panel}|${r.feature}`] || []).push(r); });
  Object.entries(byFeature).forEach(([key, list]) => {
    const [panel, feature] = key.split('|');
    out.push(`### ${feature} (${panel} panel)`, '', '| Test case | Result |', '|---|---|');
    list.forEach((r) => out.push(`| ${r.test.replace(/\|/g, '/')} | ${r.status === 'passed' ? 'PASS' : 'FAIL'} |`));
    out.push('');
  });
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, out.join('\n'));
console.log(`Wrote ${output}: ${rows.length} tests, ${passed} passed, ${failed} failed`);
