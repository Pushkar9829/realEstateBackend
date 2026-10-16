// Read-only coverage report for the demo data: per model, the document count and
// the schema paths that no document populates (ignores _id, __v, createdAt, updatedAt).
//   node scripts/demo-coverage.js            (from backend/; LOCAL re_dev by default)
//   node scripts/demo-coverage.js --json     machine-readable output
const { loadSafeEnv } = require('./demo-data/safe-env');

loadSafeEnv();
const mongoose = require('mongoose');

// Load every model.
require('../src/modules');
require('../src/core/storage');
require('../src/core/counters');
require('../src/core/settings');
require('../src/core/audit');
require('../src/core/jobs/Job.model');
require('../src/core/outbox/Outbox.model');

const IGNORE = new Set(['_id', '__v', 'createdAt', 'updatedAt', 'id']);

// Leaf paths of a schema, descending into nested / array sub-schemas.
function leafPaths(schema, prefix = '') {
  const out = [];
  schema.eachPath((p, type) => {
    const last = p.split('.').pop();
    if (IGNORE.has(p) || IGNORE.has(last)) return;
    const full = prefix + p;
    if (type.schema) {
      const inner = leafPaths(type.schema, `${full}.`);
      if (inner.length) out.push(...inner); else out.push(full);
    } else out.push(full);
  });
  return out;
}

// "Populated" = at least one value of a real type at the path (array elements count
// one by one, so a path inside an array of sub-documents is populated when any
// element has it). null, missing and empty arrays do not count.
const populated = { $type: ['double', 'string', 'object', 'objectId', 'bool', 'date', 'int', 'long', 'decimal', 'timestamp', 'binData'] };

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const rows = [];
  for (const name of mongoose.modelNames().sort()) {
    const Model = mongoose.model(name);
    const count = await Model.collection.countDocuments({});
    const paths = leafPaths(Model.schema);
    const empty = [];
    for (const p of paths) {
      if (!count) { empty.push(p); continue; }
      const n = await Model.collection.countDocuments({ [p]: populated }, { limit: 1 });
      if (!n) empty.push(p);
    }
    rows.push({ model: name, count, paths: paths.length, empty });
  }
  const emptyModels = rows.filter((r) => !r.count);
  const totalEmpty = rows.reduce((a, r) => a + r.empty.length, 0);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ models: rows.length, emptyModels: emptyModels.length, neverFilled: totalEmpty, rows }, null, 2));
  } else {
    for (const r of rows) {
      console.log(`${r.model.padEnd(20)} ${String(r.count).padStart(5)} docs  ${String(r.empty.length).padStart(3)}/${r.paths} never filled`);
      if (r.empty.length && r.count) console.log(`    ${r.empty.join(', ')}`);
    }
    console.log(`\nDB ${mongoose.connection.name}: ${rows.length} models, ${emptyModels.length} empty collections, ${totalEmpty} never-filled fields`);
    if (emptyModels.length) console.log(`Empty: ${emptyModels.map((r) => r.model).join(', ')}`);
  }
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
