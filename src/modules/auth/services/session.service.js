// Sessions = refresh-token families. Each login starts a family; every
// refresh rotates the token inside it. Presenting an already-rotated token is
// treated as theft: the whole family is revoked (spec 4.1 workflow step 5).
const crypto = require('crypto');
const { RefreshToken, LoginHistory } = require('../models');
const { ApiError } = require('../../../core/http');
const { sha256, randomToken } = require('../../../core/security/crypto');
const { signAccess, ACCESS_TTL } = require('../../../core/security/jwt');
const { securityEvent } = require('../../../core/audit');
const settings = require('../../../core/settings');
const env = require('../../../config/env');

const clientInfo = (req) => ({ ip: req.ip, ua: String(req.headers['user-agent'] || '').slice(0, 300) });

async function newRefresh(userId, familyId, req) {
  const token = randomToken(48);
  await RefreshToken.create({
    userId, familyId, tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86400000), ...clientInfo(req), lastUsedAt: new Date(),
  });
  return token;
}

// Revoke the oldest families beyond auth.maxSessions.
async function enforceMaxSessions(userId) {
  const max = await settings.get('auth.maxSessions');
  const active = await RefreshToken.aggregate([
    { $match: { userId, revokedAt: null, expiresAt: { $gt: new Date() } } },
    { $group: { _id: '$familyId', started: { $min: '$createdAt' } } },
    { $sort: { started: 1 } },
  ]);
  const excess = active.slice(0, Math.max(0, active.length - max)).map((f) => f._id);
  if (excess.length) await RefreshToken.updateMany({ familyId: { $in: excess }, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

async function start(user, req, method) {
  const familyId = crypto.randomUUID();
  const refreshToken = await newRefresh(user._id, familyId, req);
  await enforceMaxSessions(user._id);
  await LoginHistory.create({ userId: user._id, success: true, method, ...clientInfo(req) });
  return { accessToken: signAccess(user, familyId), refreshToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL };
}

async function rotate(refreshToken, req) {
  const { User } = require('../models');
  const doc = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
  if (!doc) throw ApiError.unauthenticated('Invalid refresh token', 'INVALID_REFRESH');
  if (doc.revokedAt) {
    if (doc.replacedBy) { // a rotated token came back: likely stolen
      await RefreshToken.updateMany({ familyId: doc.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
      await securityEvent(req, 'token.reuse_detected', { userId: doc.userId, meta: { familyId: doc.familyId } });
    }
    throw ApiError.unauthenticated('Session ended, please log in again', 'INVALID_REFRESH');
  }
  if (doc.expiresAt < new Date()) throw ApiError.unauthenticated('Session expired, please log in again', 'INVALID_REFRESH');
  const user = await User.findById(doc.userId);
  if (!user || user.status !== 'active') throw ApiError.unauthenticated('Account is not active', 'INVALID_REFRESH');

  const next = await newRefresh(user._id, doc.familyId, req);
  doc.revokedAt = new Date();
  doc.replacedBy = sha256(next);
  await doc.save();
  return { accessToken: signAccess(user, doc.familyId), refreshToken: next, tokenType: 'Bearer', expiresIn: ACCESS_TTL };
}

async function revokeFamily(familyId, userId) {
  const filter = { familyId, revokedAt: null };
  if (userId) filter.userId = userId;
  const r = await RefreshToken.updateMany(filter, { $set: { revokedAt: new Date() } });
  return r.modifiedCount;
}

async function revokeByToken(refreshToken) {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
  if (doc) await revokeFamily(doc.familyId);
}

const revokeAll = (userId) => RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });

// Active sessions = latest live token per family.
async function list(userId, currentSid) {
  const rows = await RefreshToken.aggregate([
    { $match: { userId, revokedAt: null, expiresAt: { $gt: new Date() } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$familyId', ip: { $first: '$ip' }, ua: { $first: '$ua' }, lastUsedAt: { $first: '$createdAt' }, startedAt: { $last: '$createdAt' } } },
    { $sort: { lastUsedAt: -1 } },
  ]);
  return rows.map((r) => ({ id: r._id, ip: r.ip, device: r.ua, startedAt: r.startedAt, lastUsedAt: r.lastUsedAt, current: r._id === currentSid }));
}

// Was this ip + device seen in a successful login before? (new-device email)
async function isKnownDevice(userId, req) {
  const { ip, ua } = clientInfo(req);
  return Boolean(await LoginHistory.exists({ userId, success: true, ip, ua }));
}

module.exports = { start, rotate, revokeFamily, revokeByToken, revokeAll, list, isKnownDevice, clientInfo };
