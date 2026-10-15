// Request validation with zod. Usage:
//   router.post('/x', validate({ body: schema, query: schema, params: schema }), handler)
// Parsed (coerced, stripped) values replace the originals.
const ApiError = require('../http/ApiError');

const validate = (schemas) => (req, res, next) => {
  const details = [];
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part] ?? {});
    if (result.success) {
      if (part === 'query') Object.defineProperty(req, 'query', { value: result.data, writable: true });
      else req[part] = result.data;
    } else {
      result.error.issues.forEach((i) => details.push({ in: part, path: i.path.join('.'), message: i.message }));
    }
  }
  return details.length ? next(ApiError.validation(details)) : next();
};

module.exports = validate;
