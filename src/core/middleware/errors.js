// 404 and central error handler producing the standard error envelope:
// { success: false, error: { code, message, details? } }
const mongoose = require('mongoose');
const { ZodError } = require('zod');
const logger = require('../logger');
const ApiError = require('../http/ApiError');

function notFound(req, res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`, 'ROUTE_NOT_FOUND'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let e = err;
  if (err instanceof ZodError) {
    e = ApiError.validation(err.issues.map((i) => ({ in: 'body', path: i.path.join('.'), message: i.message })));
  } else if (err instanceof mongoose.Error.ValidationError) {
    e = ApiError.validation(Object.values(err.errors).map((x) => ({ in: 'body', path: x.path, message: x.message })));
  } else if (err instanceof mongoose.Error.CastError) {
    e = ApiError.badRequest(`Invalid ${err.path}`, 'INVALID_ID');
  } else if (err && err.code === 11000) {
    e = ApiError.conflict(`Duplicate value for ${Object.keys(err.keyValue || {}).join(', ') || 'unique field'}`, 'DUPLICATE');
  } else if (err && err.type === 'entity.parse.failed') {
    e = ApiError.badRequest('Malformed JSON body', 'BAD_JSON');
  } else if (err && err.type === 'entity.too.large') {
    e = ApiError.badRequest('Request body too large', 'PAYLOAD_TOO_LARGE');
  }

  const status = e.status || 500;
  if (status >= 500) logger.error({ err, reqId: req.id, url: req.originalUrl }, 'Unhandled error');

  res.status(status).json({
    success: false,
    error: {
      code: e.code || 'INTERNAL',
      message: e.expose ? e.message : 'Something went wrong',
      ...(e.details ? { details: e.details } : {}),
      requestId: req.id,
    },
  });
}

module.exports = { notFound, errorHandler };
