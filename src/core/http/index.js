// HTTP helpers shared by every controller.
const ApiError = require('./ApiError');

// Wrap async handlers so rejected promises reach the error handler.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Standard success envelope: { success, data, meta? }
function ok(res, data, meta, status = 200) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}
const created = (res, data) => ok(res, data, undefined, 201);
const noContent = (res) => res.status(204).end();

// ?page=1&limit=20&sort=-createdAt  (limit capped at 100)
function parsePaging(query, { defaultSort = '-createdAt', maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || 20));
  const sort = typeof query.sort === 'string' && /^-?[\w.]+$/.test(query.sort) ? query.sort : defaultSort;
  return { page, limit, skip: (page - 1) * limit, sort };
}

async function paginate(model, filter, query, { projection, populate, lean = true, ...opts } = {}) {
  const { page, limit, skip, sort } = parsePaging(query, opts);
  let q = model.find(filter, projection).sort(sort).skip(skip).limit(limit);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, model.countDocuments(filter)]);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// Placeholder handler for endpoints that are designed (routed, guarded,
// documented) but whose business logic lands in a later milestone.
function notImplemented(featureId) {
  const handler = (req, res, next) => next(ApiError.notImplemented(featureId));
  handler.notImplemented = true; // lets scripts/print-routes.js report build progress
  handler.featureId = featureId;
  return handler;
}

module.exports = { ApiError, asyncHandler, ok, created, noContent, parsePaging, paginate, notImplemented };
