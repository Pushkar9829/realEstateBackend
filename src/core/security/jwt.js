// Token helpers. Access tokens are short-lived JWTs carrying the session id
// (refresh-token family). Challenge (login 2FA), verification (signup OTPs),
// step-up and invite tokens are JWTs with a dedicated `typ`, so none of them
// can ever be used as an access token. Refresh tokens are opaque random
// strings stored hashed in the database.
const jwt = require('jsonwebtoken');
const env = require('../../config/env');

const ISSUER = 'realestate-api';
const sign = (payload, expiresIn) => jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn, issuer: ISSUER });

const signAccess = (user, sid) => jwt.sign(
  { sub: String(user._id), role: user.role, sid, typ: 'access' },
  env.JWT_ACCESS_SECRET,
  { expiresIn: env.JWT_ACCESS_TTL, issuer: ISSUER },
);

// Login step 1 -> step 2 (5 minutes). `cid` = the login challenge (Otp document) id.
const signChallenge = (userId, cid) => sign({ sub: String(userId), typ: 'challenge', cid: String(cid) }, '5m');

// Signup contact verification (24 hours, lets the user resend and verify OTPs).
const signVerification = (userId) => sign({ sub: String(userId), typ: 'verify' }, '24h');

// Sensitive action confirmation (5 minutes, scoped to one action).
const signStepUp = (userId, action) => sign({ sub: String(userId), typ: 'stepup', action }, '5m');

// Staff invitation set-password link (48 hours, single use via nonce stored on the user).
const signInvite = (userId, nonce) => sign({ sub: String(userId), typ: 'invite', nonce }, '48h');

// Guest enquiry: proves the phone was verified by OTP in the last 10 minutes (spec C1).
const signGuest = (phone) => sign({ sub: String(phone), typ: 'guest' }, '10m');

function verify(token, typ) {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER });
  if (payload.typ !== typ) throw new jwt.JsonWebTokenError('Wrong token type');
  return payload;
}

module.exports = { signAccess, signChallenge, signVerification, signStepUp, signInvite, signGuest, verify, ACCESS_TTL: env.JWT_ACCESS_TTL };
