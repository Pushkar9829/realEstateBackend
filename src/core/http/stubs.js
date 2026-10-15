// Builds a controller object whose handlers are designed-but-not-built
// placeholders. Each handler answers 501 NOT_IMPLEMENTED with its module
// letter and operation name, so routing, guards and validation can be wired
// and tested before the business logic is written.
//
//   module.exports = stubs('B', ['getOnboarding', 'saveStep'])
//
// When a handler is implemented, replace the stub with a real function:
//   module.exports = { ...stubs('B', [...]), getOnboarding: asyncHandler(async (req, res) => ...) }
const { notImplemented } = require('./index');

module.exports = (moduleLetter, names) =>
  Object.fromEntries(names.map((name) => [name, notImplemented(`RE-${moduleLetter}:${name}`)]));
