// Maintenance mode, kill switches and the rotated CC key, cached for 5 s.
const { CcState } = require('./models');

const TTL_MS = 5000;
let cache = null;
let cachedAt = 0;

async function get() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const doc = await CcState.findById('state').lean();
  cache = doc || { _id: 'state', maintenance: { on: false }, flags: {}, key: {} };
  cache.flags = cache.flags || {};
  cache.key = cache.key || {};
  cachedAt = Date.now();
  return cache;
}

const clear = () => { cache = null; };

async function update(set) {
  await CcState.updateOne({ _id: 'state' }, { $set: set }, { upsert: true });
  clear();
  return get();
}

async function isPaused(key) {
  const s = await get();
  return Boolean(s.flags[key] && s.flags[key].paused);
}

module.exports = { get, update, clear, isPaused };
