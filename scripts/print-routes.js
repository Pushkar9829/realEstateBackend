// Prints the API route map grouped by panel and module, with build status.
//   npm run routes            table
//   npm run routes -- --json  JSON (used to generate docs)
process.env.JOBS_ENABLED = 'false';
const listRoutes = require('../src/core/http/listRoutes');

const rows = listRoutes();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

let panel; let mod;
rows.forEach((r) => {
  if (r.panel !== panel) { panel = r.panel; mod = null; console.log(`\n=== ${panel.toUpperCase()} ===`); }
  if (r.module !== mod) { mod = r.module; console.log(`  -- ${mod}`); }
  console.log(`     ${r.implemented ? 'done' : 'todo'}  ${r.method.padEnd(6)} ${r.path}`);
});
const done = rows.filter((r) => r.implemented).length;
console.log(`\n${rows.length} endpoints, ${done} implemented, ${rows.length - done} designed (501 until built)`);
