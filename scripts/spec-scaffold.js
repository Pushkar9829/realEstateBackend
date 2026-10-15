// One-time scaffold generator: reads ../docs/SPEC.md and writes
//   src/constants/permissions.js       (section 2 permission keys)
//   src/constants/settings.defaults.js (section 7 settings table)
//   src/constants/status.js            (all "<Name> state machine" tables)
//   src/modules/<module>/controllers/<panel>.controller.js  (stubs)
//   src/modules/<module>/routes/<panel>.routes.js           (from the API tables)
// Existing files are never overwritten unless --force is passed, so modules
// that have been implemented by hand are safe.
//   node scripts/spec-scaffold.js [--force] [--only=constants|routes]
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SPEC = fs.readFileSync(path.resolve(ROOT, '../docs/SPEC.md'), 'utf8').split(/\r?\n/);
const FORCE = process.argv.includes('--force');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const written = [];

function write(rel, content) {
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file) && !FORCE) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  written.push(rel);
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRow = (line) => /^\|/.test(line.trim()) && !/^\|\s*-/.test(line.trim());
const camel = (s) => {
  const out = s.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('') || 'handler';
  return /^[0-9]/.test(out) ? `get${out}` : out; // identifiers cannot start with a digit
};

// ------------------------------------------------------------------ modules
const MODULES = {
  A: { folder: 'listings', name: 'Property Listing & Catalog Management' },
  B: { folder: 'masking', name: 'Identity & Contact Masking' },
  C: { folder: 'leads', name: 'Integrated Lead Management System' },
  D: { folder: 'approvals', name: 'Admin Approval & Operations' },
  E: { folder: 'search', name: 'Search & Discovery' },
  F: { folder: 'kyc', name: 'Lister Verification (KYC) & No-Broker Enforcement' },
  G: { folder: 'projects', name: 'Builder Projects' },
  H: { folder: 'deals', name: 'Deals & Receipt Verification' },
  I: { folder: 'receivables', name: 'Commission Receivables & Invoicing' },
  J: { folder: 'teams', name: 'Teams & Territory Management' },
  K: { folder: 'notifications', name: 'Notifications' },
  L: { folder: 'cms', name: 'CMS & Masters' },
  M: { folder: 'auth', name: 'Authentication & Account Security' },
  N: { folder: 'mlm', name: 'MLM Referral Capture & Outbox' },
  O: { folder: 'reports', name: 'Reports, Audit & System Logs' },
};
const PANELS = [
  { name: 'integrations', prefix: '/api/webhooks', mount: '/api' },
  { name: 'lister', prefix: '/api/lister', mount: '/api/lister' },
  { name: 'agent', prefix: '/api/agent', mount: '/api/agent' },
  { name: 'admin', prefix: '/api/admin', mount: '/api/admin' },
  { name: 'public', prefix: '/api', mount: '/api' },
];

// ------------------------------------------------------------------ API rows
function apiRows() {
  const rows = [];
  let mod = null;
  SPEC.forEach((line, i) => {
    const m = line.match(/^### 4\.\d+ Module ([A-O]) /);
    if (m) mod = m[1];
    if (/^## [5-9]\./.test(line)) mod = null;
    if (!mod || !isRow(line)) return;
    const [method, p, role, purpose] = cells(line);
    if (!/^(GET|POST|PUT|PATCH|DELETE)(\/(GET|POST|PUT|PATCH|DELETE))*$/.test(method) || !p.startsWith('/api/')) return;
    const methods = method.split('/');
    const optionalId = p.includes('(/:id)');
    const base = p.replace('(/:id)', '');
    methods.forEach((mt) => {
      const full = optionalId && ['PATCH', 'PUT', 'DELETE'].includes(mt) ? `${base}/:id` : base;
      rows.push({ module: mod, method: mt, path: full, role, purpose, line: i + 1 });
      if (optionalId && mt === 'GET') rows.push({ module: mod, method: 'GET', path: `${base}/:id`, role, purpose: `${purpose} detail`, line: i + 1 });
    });
  });
  const seen = new Set();
  return rows.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function guardFor(role, panel) {
  const r = role.toLowerCase();
  const perms = (role.match(/\(([^)]*)\)/) || [])[1];
  const keys = perms ? perms.split(/[,\s]+/).filter((k) => /^[a-z_]+\.[a-z_*]+$/.test(k)) : [];
  if (panel === 'integrations') return [];
  if (panel === 'admin') {
    if (keys.length) return [`...g.can(${keys.map((k) => `'${k}'`).join(', ')})`];
    if (r.startsWith('manager')) return []; // panel guard already allows managers
    return ['...g.staffOnly'];
  }
  if (panel === 'lister') return r.includes('builder') ? ['...g.builder'] : [];
  if (panel === 'agent') return keys.length ? [`...g.can(${keys.map((k) => `'${k}'`).join(', ')})`] : [];
  // public panel
  if (r.startsWith('public, buyer')) return ['...g.optional'];
  if (r.startsWith('public') || r.startsWith('provider')) return [];
  if (r.startsWith('buyer, lister')) return ['...g.buyerOrLister'];
  if (r.startsWith('buyer')) return ['...g.buyer'];
  if (r.startsWith('lister, agent')) return ['...g.listerOrStaff'];
  if (r.startsWith('any')) return ['...g.anyUser'];
  return ['...g.anyUser'];
}

// Literal segments before :params so /leads/board wins over /leads/:id.
function specificity(a, b) {
  const x = a.sub.split('/'); const y = b.sub.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    if (x[i] === y[i]) continue;
    const px = x[i].startsWith(':'); const py = y[i].startsWith(':');
    if (px && !py) return 1;
    if (!px && py) return -1;
    return 0;
  }
  return 0;
}

function genRoutes() {
  const rows = apiRows();
  const byModPanel = {};
  rows.forEach((r) => {
    const panel = PANELS.find((p) => r.path === p.prefix || r.path.startsWith(`${p.prefix}/`));
    const sub = r.path.slice(panel.mount.length) || '/';
    const key = `${r.module}|${panel.name}`;
    (byModPanel[key] = byModPanel[key] || []).push({ ...r, panel: panel.name, sub });
  });

  const moduleIndex = {};
  Object.entries(byModPanel).forEach(([key, list]) => {
    const [mod, panel] = key.split('|');
    const { folder, name } = MODULES[mod];
    list.sort(specificity);
    const names = new Set();
    list.forEach((r) => {
      let n = camel(r.purpose);
      if (names.has(n)) n = `${n}${r.method[0]}${r.method.slice(1).toLowerCase()}`;
      let k = 2;
      while (names.has(n)) { n = `${camel(r.purpose)}${k}`; k += 1; }
      names.add(n);
      r.handler = n;
    });
    const mount = PANELS.find((p) => p.name === panel).mount;
    write(`src/modules/${folder}/controllers/${panel}.controller.js`,
      `// Module ${mod} - ${name}: ${panel} panel handlers.\n// Generated from docs/SPEC.md. Replace each stub with a real handler as the\n// module is implemented (see core/http/stubs.js).\nconst stubs = require('../../../core/http/stubs');\n\nmodule.exports = stubs('${mod}', [\n${list.map((r) => `  '${r.handler}', // ${r.method} ${r.path} - ${r.purpose}`).join('\n')}\n]);\n`);
    write(`src/modules/${folder}/routes/${panel}.routes.js`,
      `// Module ${mod} - ${name}: ${panel} panel routes (mounted at ${mount}).\n// Generated from the API tables in docs/SPEC.md (method, path, role / permission).\nconst router = require('express').Router();\nconst c = require('../controllers/${panel}.controller');\n${list.some((r) => guardFor(r.role, panel).length) ? "const g = require('../../../core/middleware/guards');\n" : ''}\n${list.map((r) => {
        const guards = guardFor(r.role, panel);
        return `router.${r.method.toLowerCase()}('${r.sub}', ${guards.length ? `${guards.join(', ')}, ` : ''}c.${r.handler}); // ${r.role}: ${r.purpose}`;
      }).join('\n')}\n\nmodule.exports = router;\n`);
    (moduleIndex[mod] = moduleIndex[mod] || []).push(panel);
  });

  Object.entries(MODULES).forEach(([mod, { folder, name }]) => {
    const panels = (moduleIndex[mod] || []).sort();
    write(`src/modules/${folder}/index.js`,
      `// Module ${mod} - ${name}\nmodule.exports = {\n  key: '${folder}',\n  letter: '${mod}',\n  name: '${name}',\n  models: fileExists('./models') ? require('./models') : {},\n  routes: {\n${panels.map((p) => `    ${p}: require('./routes/${p}.routes'),`).join('\n')}\n  },\n  register() {},\n};\n\nfunction fileExists(rel) {\n  try { require.resolve(rel, { paths: [__dirname] }); return true; } catch { return false; }\n}\n`);
  });
  console.log(`API rows: ${rows.length}`);
}

// ------------------------------------------------------------------ constants
function sectionLines(startRx, endRx) {
  const s = SPEC.findIndex((l) => startRx.test(l));
  const e = SPEC.findIndex((l, i) => i > s && endRx.test(l));
  return SPEC.slice(s, e);
}

function genPermissions() {
  const lines = sectionLines(/^## 2\./, /^## 3\./);
  const perms = [];
  lines.forEach((l) => {
    const m = l.match(/^- `([a-z_]+\.[a-z_]+)`(\s*\(\*\))?(?:\s*-\s*(.*))?$/);
    if (m) perms.push({ key: m[1], managerDefault: Boolean(m[2]), description: (m[3] || m[1]).replace(/\.$/, '') });
  });
  write('src/constants/permissions.js',
    `// Admin / manager permission catalogue (spec section 2). Generated from docs/SPEC.md.\n// A super admin holds every key. Managers receive MANAGER_DEFAULTS, scoped to their teams.\nconst PERMISSIONS = Object.freeze({\n${perms.map((p) => `  '${p.key}': ${JSON.stringify(p.description)},`).join('\n')}\n});\n\nconst ALL_PERMISSIONS = Object.keys(PERMISSIONS);\nconst MANAGER_DEFAULTS = [${perms.filter((p) => p.managerDefault).map((p) => `'${p.key}'`).join(', ')}];\n\nmodule.exports = { PERMISSIONS, ALL_PERMISSIONS, MANAGER_DEFAULTS };\n`);
  console.log(`Permissions: ${perms.length}`);
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === '(empty)' || v === '-') return '';
  if (/^\[.*\]$/.test(v)) { try { return JSON.parse(v.replace(/'/g, '"')); } catch { return v; } }
  return v;
}

function genSettings() {
  const lines = sectionLines(/^## 7\./, /^## 8\./);
  const out = [];
  lines.filter(isRow).forEach((l) => {
    const [key, def, description, edit] = cells(l);
    if (!/^[a-z][\w.]*(\s*\/\s*[\w.]+)?$/.test(key)) return;
    // "a.min / a.max" with "300 / 500" -> two keys
    const keys = key.split('/').map((k) => k.trim());
    const defs = keys.length > 1 ? def.split('/').map((d) => d.trim()) : [def];
    const prefix = keys[0].split('.').slice(0, -1).join('.');
    keys.forEach((k, i) => {
      const full = k.includes('.') ? k : `${prefix}.${k}`;
      out.push({ key: full, value: parseValue(defs[i] !== undefined ? defs[i] : def), description, edit: edit || 'settings.manage' });
    });
  });
  write('src/constants/settings.defaults.js',
    `// Platform settings (spec section 7), generated from docs/SPEC.md. Values live in\n// the \`settings\` collection; these defaults apply until an admin saves an override.\n// Review values marked as text (e.g. "(seed)") when implementing their module.\nconst S = (value, edit, description) => ({ value, edit, description });\n\nmodule.exports = {\n${out.map((s) => `  ${JSON.stringify(s.key)}: S(${JSON.stringify(s.value)}, ${JSON.stringify(s.edit)}, ${JSON.stringify(s.description)}),`).join('\n')}\n};\n`);
  console.log(`Settings: ${out.length}`);
}

function genStatus() {
  const machines = {};
  SPEC.forEach((line, i) => {
    const m = line.match(/^([A-Z][\w ]*?) state machine\b/);
    if (!m) return;
    const name = camel(m[1]);
    const t = machines[name] = machines[name] || {};
    for (let j = i + 1; j < SPEC.length && j < i + 60; j += 1) {
      const l = SPEC[j];
      if (!l.trim() && j > i + 2) break;
      if (!isRow(l) || /^\| From/.test(l)) continue;
      const [from, , to] = cells(l);
      const clean = (s) => s.split(/,|\//).map((x) => x.trim().replace(/\s*\(.*$/, '').replace(/[`*]/g, '')).filter((x) => /^[a-z_]+$/.test(x));
      const froms = from.includes('(none)') ? ['(none)'] : clean(from);
      const tos = clean(to);
      froms.forEach((f) => { t[f] = [...new Set([...(t[f] || []), ...tos])]; });
      tos.forEach((x) => { t[x] = t[x] || []; });
    }
  });
  const body = Object.entries(machines).map(([name, t]) => {
    const initial = t['(none)'] || [];
    delete t['(none)'];
    return `  ${name}: machine(${JSON.stringify(initial)}, {\n${Object.entries(t).map(([f, to]) => `    ${f}: ${JSON.stringify(to)},`).join('\n')}\n  }),`;
  }).join('\n');
  write('src/constants/status.js',
    `// Status machines generated from the "<Name> state machine" tables in docs/SPEC.md.\n// Services must change status through assertTransition so illegal moves are\n// rejected in one place.\nconst ApiError = require('../core/http/ApiError');\n\nconst machine = (initial, transitions) => ({\n  initial,\n  values: [...new Set([...initial, ...Object.keys(transitions), ...Object.values(transitions).flat()])],\n  transitions,\n});\n\nconst STATUS = {\n${body}\n};\n\nconst canTransition = (kind, from, to) => Boolean(STATUS[kind] && STATUS[kind].transitions[from] && STATUS[kind].transitions[from].includes(to));\n\nfunction assertTransition(kind, from, to) {\n  if (!canTransition(kind, from, to)) throw ApiError.conflict(\`Cannot move \${kind} from "\${from}" to "\${to}"\`, 'INVALID_TRANSITION');\n}\n\nmodule.exports = { STATUS, canTransition, assertTransition };\n`);
  console.log(`State machines: ${Object.keys(machines).join(', ')}`);
}

if (!ONLY || ONLY === 'constants') { genPermissions(); genSettings(); genStatus(); }
if (!ONLY || ONLY === 'routes') genRoutes();
console.log(`Wrote ${written.length} files${FORCE ? ' (forced)' : ''}`);
written.forEach((w) => console.log(`  ${w}`));
