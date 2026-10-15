// Platform settings: defaults in constants/settings.defaults.js, overrides in
// the `settings` collection. Values are cached in memory for 30 s (no Redis);
// a write on this instance clears the cache immediately.
const mongoose = require('mongoose');
const DEFAULTS = require('../constants/settings.defaults');

const Setting = mongoose.model('Setting', new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
));

const TTL_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

async function all() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const rows = await Setting.find().lean();
  const merged = Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, d.value]));
  rows.forEach((r) => { if (r.key in DEFAULTS) merged[r.key] = r.value; });
  cache = merged;
  cachedAt = Date.now();
  return merged;
}

async function get(key) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  return (await all())[key];
}

async function set(key, value, userId) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  await Setting.updateOne({ key }, { value, updatedBy: userId }, { upsert: true });
  cache = null;
}

const describe = () => Object.entries(DEFAULTS).map(([key, d]) => ({ key, default: d.value, edit: d.edit, description: d.description }));
const clearCache = () => { cache = null; };

module.exports = { get, all, set, describe, clearCache, Setting };
