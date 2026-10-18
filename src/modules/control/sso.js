// Single sign-on from the Control Center (CC_CONTRACT.md section 7).
//   POST /api/auth/cc-sso { assertion }  ->  this platform's normal login payload + cc context
// The assertion is an RS256 JWT verified against the Control Center JWKS
// (cached 10 min), audience-bound, at most 60 s long and single use (jti).
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { CcJti, CcLink } = require('./models');
const provider = require('./provider');

const { ApiError } = provider;
const CACHE_MS = 10 * 60000;
const REFETCH_MIN_MS = 30000;
let jwksCache = { keys: new Map(), at: 0 };

async function fetchJwks(url) {
  const res = await axios.get(url, { timeout: 5000, validateStatus: () => true });
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.keys)) throw new Error(`JWKS answered ${res.status}`);
  const keys = new Map();
  res.data.keys.filter((k) => k.kty === 'RSA' && k.kid).forEach((k) => {
    keys.set(k.kid, crypto.createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: 'jwk' }).export({ type: 'spki', format: 'pem' }));
  });
  jwksCache = { keys, at: Date.now() };
}

async function keyFor(kid) {
  const cfg = config.read();
  const stale = Date.now() - jwksCache.at > CACHE_MS;
  if (stale || (!jwksCache.keys.has(kid) && Date.now() - jwksCache.at > REFETCH_MIN_MS)) {
    try { await fetchJwks(cfg.jwksUrl); } catch (err) {
      if (!jwksCache.keys.has(kid)) throw new ApiError(503, 'SSO_UNAVAILABLE', 'The Control Center keys could not be loaded. Try again shortly.');
    }
  }
  return jwksCache.keys.get(kid);
}

const resetCache = () => { jwksCache = { keys: new Map(), at: 0 }; };
const allowedRoles = () => config.read().ssoRoles || provider.sso.roles;

// Linked staff account for a Control Center subject (just-in-time, B8).
async function linkedUser({ sub, email, name }, role) {
  const link = await CcLink.findOne({ sub });
  if (link) {
    const user = await provider.sso.findUser(link.userId);
    if (user) {
      if (role && link.role !== role) {
        await provider.sso.setRole(user, role);
        link.role = role;
      }
      link.email = email || link.email; link.name = name || link.name;
      await link.save();
      return provider.sso.findUser(link.userId);
    }
    await CcLink.deleteOne({ _id: link._id }); // the platform user was removed: link again
  }
  const user = await provider.sso.createUser({ sub, name: `${name || 'Owner'} (Control Center)`.slice(0, 80) }, role);
  await CcLink.create({ sub, userId: user._id, email, name, role });
  return user;
}

async function exchange({ assertion }, req) {
  const cfg = config.read();
  if (typeof assertion !== 'string' || assertion.length > 8000) throw new ApiError(400, 'SSO_INVALID', 'Missing assertion');
  const decoded = jwt.decode(assertion, { complete: true });
  if (!decoded || !decoded.header || decoded.header.alg !== 'RS256' || !decoded.header.kid) throw new ApiError(400, 'SSO_INVALID', 'Malformed assertion');
  const pem = await keyFor(decoded.header.kid);
  if (!pem) throw new ApiError(400, 'SSO_INVALID', 'Assertion signed with an unknown key');
  let claims;
  try {
    claims = jwt.verify(assertion, pem, { algorithms: ['RS256'], issuer: cfg.issuer, audience: cfg.audience || provider.code, clockTolerance: 5 });
  } catch (err) {
    throw new ApiError(400, 'SSO_INVALID', `Assertion rejected: ${err.message}`);
  }
  if (!claims.jti || !claims.sub || !claims.exp || !claims.iat || claims.exp - claims.iat > 60) throw new ApiError(400, 'SSO_INVALID', 'Assertion lifetime must be 60 s or less');
  if (!allowedRoles().includes(claims.role)) throw new ApiError(403, 'SSO_ROLE_DENIED', `The role ${claims.role} cannot be granted here`);
  try {
    await CcJti.create({ _id: String(claims.jti), sub: String(claims.sub) });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(401, 'SSO_REPLAYED', 'This sign-in link was already used');
    throw err;
  }
  const user = await linkedUser({ sub: String(claims.sub), email: claims.email, name: claims.name }, claims.role);
  if (user.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'The linked account is disabled on this platform');
  await CcLink.updateOne({ sub: String(claims.sub) }, { $set: { lastSsoAt: new Date() } });
  const session = await provider.sso.startSession(user, req);
  req.user = user;
  await provider.audit(req, {
    action: 'auth.cc_sso', entityType: 'User', entityId: user._id, reason: 'login via Control Center',
    after: { role: claims.role, path: claims.path, ccUser: claims.email, jti: claims.jti },
  });
  const path = typeof claims.path === 'string' && /^\/(?!\/)/.test(claims.path) ? claims.path : provider.sso.home;
  return { ...session, cc: { path, ctx: claims.ctx || {}, via: 'control-center', ccUser: { name: claims.name, email: claims.email } } };
}

module.exports = { exchange, linkedUser, resetCache, allowedRoles };
