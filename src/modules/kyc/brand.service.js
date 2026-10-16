// RE-B-02 / RE-S-LIS-16: a builder's public brand ("Verified Builder <brand>").
// The builder requests a brand (name 2-60 and an optional logo image); it
// waits in `brand.pending` until an admin approves or rejects it
// (POST /api/admin/listers/:id/approve-brand). The approved brand stays
// public while a new change is pending.
const { z } = require('zod');
const { User } = require('../auth/models');
const guard = require('../masking/guard');
const storage = require('../../core/storage');
const { ApiError } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser, notifyPermission } = require('../notifications/service');

const oid = z.string().regex(/^[a-f0-9]{24}$/, 'invalid id');
const LOGO_PURPOSES = ['avatar', 'project_media'];

const schemas = {
  request: z.object({ name: z.string().trim().min(2).max(60), logoFileId: oid.nullable().optional() }),
  decision: z.object({ decision: z.enum(['approve', 'reject']).default('approve'), reason: z.string().trim().max(300).optional() })
    .refine((d) => d.decision !== 'reject' || (d.reason && d.reason.length >= 3), { path: ['reason'], message: 'A reason is required to reject' }),
};

function brandView(u) {
  const b = (u.brand && (u.brand.toObject ? u.brand.toObject() : u.brand)) || {};
  const pending = b.pending && b.pending.name ? b.pending : null;
  return {
    name: b.name || null, logoUrl: b.logoUrl || null, approved: Boolean(b.approved),
    pending, rejectReason: b.rejectReason || null, reviewedAt: b.reviewedAt || null,
    publicLabel: b.approved && b.name ? `Verified Builder · ${b.name}` : 'Verified Builder',
  };
}

async function builderOr404(userId) {
  const u = await User.findOne({ _id: userId, role: 'lister' });
  if (!u) throw ApiError.notFound('Lister not found');
  if (u.listerType !== 'builder') throw ApiError.conflict('Brands apply to builder accounts only', 'BUILDERS_ONLY');
  return u;
}

async function getOwn(user) {
  return brandView(await builderOr404(user._id));
}

// PATCH /api/lister/profile/brand
async function request(user, body, req) {
  const d = schemas.request.parse(body);
  await guard.assertNoContactInfo({ name: d.name }, req); // edge case: a brand name with a phone number
  const u = await builderOr404(user._id);
  let logo = {};
  if (d.logoFileId) {
    const f = await storage.FileModel.findOne({ _id: d.logoFileId, ownerId: u._id, purpose: { $in: LOGO_PURPOSES } });
    if (!f || !String(f.mime || '').startsWith('image/')) throw ApiError.validation([{ in: 'body', path: 'logoFileId', message: 'Upload the logo image first' }]);
    logo = { logoFileId: f._id, logoUrl: storage.urlFor(f) };
  } else if (d.logoFileId === undefined && u.brand) {
    logo = { logoFileId: u.brand.logoFileId, logoUrl: u.brand.logoUrl }; // keep the current logo
  }
  u.brand = u.brand || {};
  u.brand.pending = { name: d.name, ...logo, requestedAt: new Date() };
  u.brand.rejectReason = undefined;
  u.markModified('brand');
  await u.save();
  await audit(req, { action: 'brand.request', entityType: 'User', entityId: u._id, after: { name: d.name, logo: Boolean(logo.logoUrl) } });
  await notifyPermission('listers.verify', 'brand.submitted', { name: u.name, brand: d.name, userId: String(u._id) });
  return brandView(u);
}

// POST /api/admin/listers/:id/approve-brand { decision: approve | reject, reason }
async function decide(listerId, body, req) {
  const d = schemas.decision.parse(body || {});
  const u = await builderOr404(listerId);
  const b = u.brand || {};
  const pending = b.pending && b.pending.name ? b.pending : null;
  // A brand set at sign-up (approved: false, nothing pending) is reviewed as it is.
  const target = pending || (b.name && !b.approved ? { name: b.name, logoUrl: b.logoUrl, logoFileId: b.logoFileId } : null);
  if (!target) throw ApiError.conflict('No brand change is waiting for approval', 'NOTHING_PENDING');
  const before = { name: b.name, approved: Boolean(b.approved) };
  if (d.decision === 'approve') {
    u.brand = { name: target.name, logoUrl: target.logoUrl, logoFileId: target.logoFileId, approved: true, reviewedBy: req.user._id, reviewedAt: new Date() };
  } else {
    u.brand = { name: b.name, logoUrl: b.logoUrl, logoFileId: b.logoFileId, approved: pending ? Boolean(b.approved) : false, reviewedBy: req.user._id, reviewedAt: new Date(), rejectReason: d.reason };
  }
  u.markModified('brand');
  await u.save();
  await audit(req, { action: `brand.${d.decision}`, entityType: 'User', entityId: u._id, before, after: { name: u.brand.name, approved: u.brand.approved }, reason: d.reason });
  await notifyUser({ user: u, event: 'brand.decided', channels: ['in_app', 'email'], vars: { brand: target.name, decision: d.decision === 'approve' ? 'approved' : 'not approved', note: d.decision === 'approve' ? 'It now shows publicly as "Verified Builder ' + target.name + '".' : `Reason: ${d.reason}` } });
  return brandView(u);
}

module.exports = { getOwn, request, decide, brandView, schemas };
