// Introspects the panel routers and returns every endpoint with its panel,
// owning module and whether it is implemented yet (stub handlers are tagged).
const { PANELS } = require('../../panels');
const modules = require('../../modules');

function walk(stack, prefix, out) {
  stack.forEach((layer) => {
    if (layer.route) {
      const handlers = layer.route.stack.map((s) => s.handle);
      const last = handlers[handlers.length - 1];
      Object.keys(layer.route.methods).forEach((method) => out.push({
        method: method.toUpperCase(),
        path: prefix + layer.route.path,
        implemented: !last.notImplemented,
        feature: last.featureId,
      }));
    } else if (layer.name === 'router' && layer.handle.stack) {
      walk(layer.handle.stack, prefix, out);
    }
  });
}

function listRoutes() {
  const rows = [];
  Object.entries(PANELS).forEach(([panel, { mount }]) => {
    modules.forEach((m) => {
      const r = m.routes && m.routes[panel];
      if (!r) return;
      const out = [];
      walk(r.stack, mount, out);
      out.forEach((row) => rows.push({ panel, module: `${m.letter} ${m.name}`, ...row }));
    });
  });
  return rows;
}

module.exports = listRoutes;
