// Named route guards used by the generated module routes. They map the
// "Role" column of the spec's API tables to middleware:
//   buyer               -> signed-in buyer
//   any / any logged in -> any signed-in user
//   public, buyer       -> optional login
//   buyer, lister       -> signed-in buyer or lister
//   lister, agent       -> signed-in lister or sales staff
//   lister (builder)    -> lister whose listerType is builder
//   admin               -> admin or super admin only (managers excluded)
//   admin (perm.key)    -> any panel user holding the permission (super admin passes)
const ApiError = require('../http/ApiError');
const { authenticate, optionalAuth, requireRole, requirePermission } = require('./auth');

const builderOnly = (req, res, next) => (req.user && req.user.listerType === 'builder'
  ? next()
  : next(ApiError.forbidden('Builder projects are available to builder accounts only', 'BUILDERS_ONLY')));

module.exports = {
  buyer: [authenticate, requireRole('buyer')],
  anyUser: [authenticate],
  optional: [optionalAuth],
  buyerOrLister: [authenticate, requireRole('buyer', 'lister')],
  listerOrStaff: [authenticate, requireRole('lister', 'agent', 'manager', 'admin', 'superadmin')],
  builder: [builderOnly],
  staffOnly: [requireRole('admin', 'superadmin')],
  can: (...keys) => [requirePermission(...keys)],
};
