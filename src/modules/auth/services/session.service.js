// Sessions = refresh-token families. Each login starts a family; every
// refresh rotates the token inside it. Presenting an already-rotated token is
// treated as theft: the whole family is revoked (spec 4.1 workflow step 5).
// Grace: a refresh cut off by a page reload (or two tabs refreshing at once
// with the shared stored token) never delivers the new token to the browser,
// which then sends the previous one again. The immediately previous token is
// therefore accepted ONCE within REUSE_GRACE_SECONDS of its rotation, from the
// same browser, while its successor is still unused; the successor is then
// revoked so the family keeps a single usable token (see rotate). Any other
// reuse revokes the family.
const crypto = require('crypto');
const { RefreshToken, LoginHistory } = require('../models');
const { ApiError } = require('../../../core/http');
const { sha256, randomToken } = require('../../../core/security/crypto');
const { signAccess, ACCESS_TTL } = require('../../../core/security/jwt');
const { securityEvent } = require('../../../core/audit');
const settings = require('../../../core/settings');
const env = require('../../../config/env');

const REUSE_GRACE_SECONDS = 30;

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

const withinGrace = (at) => Boolean(at) && Date.now() - at.getTime() <= REUSE_GRACE_SECONDS * 1000;
// Same browser = same IP and user agent as the request that received the token.
const sameClient = (doc, req) => { const c = clientInfo(req); return doc.ip === c.ip && doc.ua === c.ua; };
const invalid = (msg = 'Session ended, please log in again', code = 'INVALID_REFRESH') => ApiError.unauthenticated(msg, code);

async function killFamily(doc, req, reason) {
  await RefreshToken.updateMany({ familyId: doc.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  await securityEvent(req, 'token.reuse_detected', { userId: doc.userId, meta: { familyId: doc.familyId, reason } });
}

async function activeUser(doc) {
  const { User } = require('../models');
  if (doc.expiresAt < new Date()) throw invalid('Session expired, please log in again');
  const user = await User.findById(doc.userId);
  if (!user || user.status !== 'active') throw invalid('Account is not active');
  return user;
}

// The successor row is written before the parent is claimed, so a concurrent
// request that loses the claim always finds it. Its value only leaves the
// server if the claim succeeds; otherwise the row is deleted again.
async function draftSuccessor(doc, req) {
  const token = randomToken(48);
  const row = await RefreshToken.create({
    userId: doc.userId, familyId: doc.familyId, tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86400000), ...clientInfo(req), lastUsedAt: new Date(),
  });
  return { token, row, drop: () => RefreshToken.deleteOne({ _id: row._id }) };
}

const pair = (user, familyId, refreshToken) => ({ accessToken: signAccess(user, familyId), refreshToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL });

// Invariant: a family never has more than one usable refresh token.
// - live token: claimed atomically (revokedAt null -> now) and replaced by one successor.
// - grace (immediately previous token, within 30 s, same browser, successor
//   still unused): the successor is REVOKED (supersededAt) and a replacement
//   is issued from the same chain, so the chain keeps exactly one live head.
// - superseded successor presented again by the same browser within the
//   window (the other tab that lost the race): 401 REFRESH_SUPERSEDED, family
//   kept, recorded. A duplicate of a grace request still in flight (same
//   browser) is refused the same way. Anywhere else: theft, the family is revoked.
async function rotate(refreshToken, req) {
  let doc = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
  if (!doc) throw invalid('Invalid refresh token');

  if (!doc.revokedAt) {
    const user = await activeUser(doc);
    const next = await draftSuccessor(doc, req);
    const claimed = await RefreshToken.findOneAndUpdate(
      { _id: doc._id, revokedAt: null },
      { $set: { revokedAt: new Date(), replacedBy: next.row.tokenHash } },
    );
    if (claimed) return pair(user, doc.familyId, next.token);
    await next.drop(); // lost the race to a concurrent refresh: treat as a reuse
    doc = await RefreshToken.findById(doc._id);
    if (!doc) throw invalid('Invalid refresh token');
  }

  if (!doc.replacedBy) throw invalid(); // ended by logout or a family revoke

  if (doc.supersededAt) {
    const head = await RefreshToken.findOne({ familyId: doc.familyId, revokedAt: null, expiresAt: { $gt: new Date() } });
    if (head && withinGrace(doc.supersededAt) && sameClient(head, req)) {
      await securityEvent(req, 'token.superseded_reuse', { userId: doc.userId, meta: { familyId: doc.familyId } });
      throw invalid('This session was refreshed in another tab', 'REFRESH_SUPERSEDED');
    }
    await killFamily(doc, req, 'superseded_token');
    throw invalid();
  }

  const successor = await RefreshToken.findOne({ tokenHash: doc.replacedBy, revokedAt: null });
  const graceable = withinGrace(doc.revokedAt) && successor && sameClient(successor, req)
    && await RefreshToken.findOneAndUpdate({ _id: doc._id, graceUsedAt: null }, { $set: { graceUsedAt: new Date() } });
  if (!graceable) {
    // A duplicate of the request that is using the grace right now (same
    // browser, grace not finished yet): refuse it without ending the session.
    const now = await RefreshToken.findById(doc._id).lean();
    if (now && now.graceUsedAt && !now.graceDoneAt && withinGrace(now.graceUsedAt) && successor && sameClient(successor, req)) {
      await securityEvent(req, 'token.reuse_concurrent', { userId: doc.userId, meta: { familyId: doc.familyId } });
      throw invalid('This session was refreshed in another tab', 'REFRESH_SUPERSEDED');
    }
    await killFamily(doc, req, 'rotated_token');
    throw invalid();
  }
  const user = await activeUser(doc);
  const next = await draftSuccessor(doc, req);
  const superseded = await RefreshToken.findOneAndUpdate(
    { _id: successor._id, revokedAt: null },
    { $set: { revokedAt: new Date(), supersededAt: new Date(), replacedBy: next.row.tokenHash } },
  );
  if (!superseded) { // the successor moved on meanwhile: no second branch, ever
    await next.drop();
    await killFamily(doc, req, 'grace_race');
    throw invalid();
  }
  await RefreshToken.updateOne({ _id: doc._id }, { $set: { graceDoneAt: new Date() } });
  await securityEvent(req, 'token.reuse_grace', { userId: doc.userId, meta: { familyId: doc.familyId } });
  return pair(user, doc.familyId, next.token);
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

module.exports = { REUSE_GRACE_SECONDS, start, rotate, revokeFamily, revokeByToken, revokeAll, list, isKnownDevice, clientInfo };
