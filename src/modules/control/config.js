// Control Center adapter configuration (control-center/docs/CC_CONTRACT.md section 1).
// The adapter is OFF unless CC_KEY_ID and CC_SECRET are both set; SSO also needs CC_JWKS_URL.
// This file is identical in the four platforms; platform specifics live in provider.js.
const env = require('../../config/env');

const SCOPES = ['ops.read', 'ops.write', 'staff.read', 'staff.write', 'settings.read', 'settings.write', 'keys.write'];
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function read() {
  const enabled = Boolean(env.CC_KEY_ID && env.CC_SECRET);
  return {
    enabled,
    keyId: env.CC_KEY_ID,
    secret: env.CC_SECRET,
    previousSecret: env.CC_SECRET_PREVIOUS || null,
    scopes: (env.CC_ALLOWED_SCOPES ? list(env.CC_ALLOWED_SCOPES) : ['ops.read']).filter((s) => SCOPES.includes(s)),
    jwksUrl: env.CC_JWKS_URL || null,
    ssoEnabled: enabled && Boolean(env.CC_JWKS_URL),
    issuer: env.CC_ISSUER || 'control-center',
    audience: env.CC_AUDIENCE || null, // default: provider.code
    ssoRoles: env.CC_SSO_ROLES ? list(env.CC_SSO_ROLES) : null, // default: provider.sso.roles
  };
}

module.exports = { read, SCOPES };
