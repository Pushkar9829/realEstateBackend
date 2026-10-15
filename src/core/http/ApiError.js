// Operational error with an HTTP status and a stable machine-readable code.
// The error handler turns it into the standard error envelope.
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  static badRequest(message, code = 'BAD_REQUEST', details) { return new ApiError(400, code, message, details); }
  static unauthenticated(message = 'Authentication required', code = 'UNAUTHENTICATED') { return new ApiError(401, code, message); }
  static forbidden(message = 'You do not have access to this resource', code = 'FORBIDDEN') { return new ApiError(403, code, message); }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND') { return new ApiError(404, code, message); }
  static conflict(message, code = 'CONFLICT', details) { return new ApiError(409, code, message, details); }
  static validation(details, message = 'Validation failed') { return new ApiError(422, 'VALIDATION_ERROR', message, details); }
  static tooMany(message = 'Too many requests, please slow down', code = 'RATE_LIMITED') { return new ApiError(429, code, message); }
  static notImplemented(feature) {
    return new ApiError(501, 'NOT_IMPLEMENTED', `Endpoint designed but not implemented yet${feature ? ` (${feature})` : ''}`);
  }
}

module.exports = ApiError;
