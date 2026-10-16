// Safe environment for the demo-data scripts. Never reads backend/.env:
// tests/env sets NODE_ENV=test and dummy secrets (config/env.js skips dotenv in
// test mode), then MONGO_URI is pointed at the LOCAL dev database. Refuses to
// run against anything that is not localhost / 127.0.0.1.
const path = require('path');

const DEFAULT_URI = 'mongodb://127.0.0.1:27040/re_dev?replicaSet=rs0&directConnection=true';

function loadSafeEnv() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run: NODE_ENV=production');
  process.chdir(path.join(__dirname, '..', '..')); // backend/ (uploads/ resolve here, as for the dev API)
  require('../../tests/env'); // NODE_ENV=test, dummy secrets, JOBS_ENABLED=false
  process.env.MONGO_URI = process.env.SEED_MONGO_URI || DEFAULT_URI;
  process.env.STORAGE_PROVIDER = 'local'; // files land in backend/uploads, served by the dev API at /uploads
  process.env.API_PUBLIC_URL = process.env.SEED_API_PUBLIC_URL || 'http://localhost:4102';
  process.env.LOG_LEVEL = 'silent';
  const host = (/^mongodb:\/\/(?:[^@/]*@)?([^/:?,]+)/.exec(process.env.MONGO_URI) || [])[1];
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error(`Refusing to run: MONGO_URI host "${host}" is not local`);
  if (process.env.MONGO_URI.startsWith('mongodb+srv')) throw new Error('Refusing to run: SRV (cloud) URI');
  const env = require('../../src/config/env');
  if (env.isProd) throw new Error('Refusing to run in production');
  return env;
}

module.exports = { loadSafeEnv, DEFAULT_URI };
