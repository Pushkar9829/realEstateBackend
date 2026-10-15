// Authentication and authorisation guards.
//   authenticate         - requires a valid access token, loads req.user
//   optionalAuth         - attaches req.user when a token is present (guest-friendly routes)
//   requireRole(...)     - panel guard (customer / vendor / delivery / admin roles)
//   requirePermission(k) - admin permission key guard (superadmin passes all)
//   requireStepUp(action)- sensitive actions need a fresh OTP (X-Step-Up-Token header)
const jwt = require('jsonwebtoken');
const ApiError = require('../http/ApiError');
const tokens = require('../security/jwt');
const { ROLES } = require('../../constants/roles');

const User = () => require('../../modules/auth/models').User; // lazy: avoids load-order cycles

function readBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

async function loadUser(token) {
  let payload;
  try {
    payload = tokens.verify(token, 'access');
  } catch (e) {
    throw ApiError.unauthenticated(e instanceof jwt.TokenExpiredError ? 'Session expired' : 'Invalid token', e instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
  }
  const user = await User().findById(payload.sub).select('+permissions').lean();
  if (!user) throw ApiError.unauthenticated('Account not found');
  if (user.status !== 'active') throw ApiError.forbidden(`Account is ${user.status}`, 'ACCOUNT_INACTIVE');
  return { user, payload };
}

// Staff created with a temporary password may only change it (or log out)
// until they do (RE-M-08 forced first-login password change).
const ALLOWED_BEFORE_PASSWORD_CHANGE = [/^GET \/api\/me$/, /^PATCH \/api\/me\/password$/, /^POST \/api\/auth\/logout(-all)?$/];

async function authenticate(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) throw ApiError.unauthenticated();
    const { user, payload } = await loadUser(token);
    req.user = user;
    req.auth = payload; // { sub, role, sid }
    const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
    if (user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.some((rx) => rx.test(route))) {
      throw ApiError.forbidden('Change your temporary password to continue', 'PASSWORD_CHANGE_REQUIRED');
    }
    next();
  } catch (e) { next(e); }
}

async function optionalAuth(req, res, next) {
  try {
    const token = readBearer(req);
    if (token) {
      const { user, payload } = await loadUser(token);
      req.user = user;
      req.auth = payload;
    }
    next();
  } catch (e) { next(e); }
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthenticated());
  if (!roles.includes(req.user.role)) return next(ApiError.forbidden('This area is not available for your account type', 'WRONG_PANEL'));
  return next();
};

const hasPermission = (user, key) => user.role === ROLES.SUPERADMIN || (user.permissions || []).includes(key);

// Any one of the given keys is enough.
const requirePermission = (...keys) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthenticated());
  if (!keys.some((k) => hasPermission(req.user, k))) return next(ApiError.forbidden(`Missing permission: ${keys.join(' or ')}`, 'MISSING_PERMISSION'));
  return next();
};

const requireSuperAdmin = requireRole(ROLES.SUPERADMIN);

const requireStepUp = (action) => (req, res, next) => {
  const token = req.headers['x-step-up-token'];
  if (!token) return next(ApiError.forbidden('Confirm this action with an OTP first', 'STEP_UP_REQUIRED'));
  try {
    const p = tokens.verify(token, 'stepup');
    if (p.sub !== String(req.user._id) || p.action !== action) throw new Error('mismatch');
    return next();
  } catch {
    return next(ApiError.forbidden('Step-up token invalid or expired', 'STEP_UP_REQUIRED'));
  }
};

module.exports = { authenticate, optionalAuth, requireRole, requirePermission, requireSuperAdmin, requireStepUp, hasPermission };
