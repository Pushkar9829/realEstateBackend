// Builds every model's indexes (TTL, unique, query indexes). Mongoose builds
// them automatically outside production only (autoIndex is off in production),
// so run this once after a deployment that adds indexes:   npm run indexes
// It only creates missing indexes; it never drops one.
const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('../src/config/db');
require('../src/app'); // loads every module's models

async function main() {
  await connectDb();
  for (const name of mongoose.modelNames().sort()) {
    await mongoose.model(name).createIndexes();
    console.log(`indexes ok: ${name}`);
  }
  await disconnectDb();
}

main().catch(async (err) => { console.error(err); await disconnectDb(); process.exit(1); });
