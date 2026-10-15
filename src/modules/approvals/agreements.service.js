// Module D - agreement registry (RE-A-10, RE-D-06/07/10, RE-G-04).
// Every commission acceptance creates an immutable, versioned agreement with
// the rendered text snapshot and its SHA-256 hash as evidence.
const PDFDocument = require('pdfkit');
const { Agreement } = require('./models');
const { User } = require('../auth/models');
const cms = require('../cms/service');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const storage = require('../../core/storage');
const { ApiError, paginate } = require('../../core/http');
const { sha256 } = require('../../core/security/crypto');
const { audit } = require('../../core/audit');
const { assertTransition } = require('../../constants/status');
const { notifyUser } = require('../notifications/service');

const render = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

async function commissionLimits(purpose) {
  const kind = purpose === 'rent' ? 'rent' : 'sale'; // projects use sale limits
  return { min: await settings.get(`commission.minPercent.${kind}`), max: await settings.get(`commission.maxPercent.${kind}`) };
}

async function assertPercent(purpose, percent) {
  const { min, max } = await commissionLimits(purpose);
  if (Math.round(percent * 100) !== percent * 100) throw ApiError.validation([{ in: 'body', path: 'percent', message: 'Use at most 2 decimals' }]);
  if (percent < min || percent > max) throw ApiError.validation([{ in: 'body', path: 'percent', message: `Commission must be between ${min}% and ${max}%` }]);
}

/**
 * Accept a commission agreement for a property or a project.
 * target: { kind: 'property'|'project', doc, purpose, ref }
 * Earlier `accepted` versions that never became active are voided.
 */
async function accept({ target, percent, typedName, lister, req, pending = false }) {
  await assertPercent(target.purpose, percent);
  const template = await cms.currentTemplate(target.purpose === 'project' ? 'project' : target.purpose);
  if (!template) throw ApiError.conflict('No published agreement template for this purpose', 'NO_TEMPLATE');
  const months = await settings.get('agreement.nonCircumventionMonths');
  const now = new Date();
  const text = render(template.body, {
    listerName: lister.kyc && lister.kyc.legalName ? lister.kyc.legalName : lister.name,
    companyName: await settings.get('general.companyName'),
    propertyRef: target.ref,
    commissionPercent: percent.toFixed(2),
    nonCircumventionMonths: months,
    acceptedName: typedName,
    acceptedAt: now.toISOString(),
  });
  const key = target.kind === 'project' ? 'projectId' : 'propertyId';
  const last = await Agreement.findOne({ [key]: target.doc._id }).sort({ version: -1 });
  // Only the latest pending acceptance survives (edge case D: two quick versions).
  const activeId = target.doc.activeAgreementId && String(target.doc.activeAgreementId);
  await Agreement.updateMany({ [key]: target.doc._id, status: 'accepted', _id: { $ne: activeId || null }, effectiveFrom: null }, { $set: { status: 'void' } });
  const ag = await Agreement.create({
    agreementNo: await counters.agreementNo(), [key]: target.doc._id, listerId: lister._id, version: (last ? last.version : 0) + 1,
    commissionPercent: percent, basis: target.purpose === 'rent' ? 'annual_rent' : 'sale_price', nonCircumventionMonths: months,
    templateId: template._id, templateVersion: template.version, textSnapshot: text, textHash: sha256(text),
    acceptedName: typedName, acceptedAt: now, ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    effectiveFrom: pending ? undefined : now,
  });
  await audit(req, { action: 'agreement.accept', entityType: 'Agreement', entityId: ag._id, after: { [key]: target.doc._id, percent, version: ag.version, pending } });
  await notifyUser({ user: lister, event: 'agreement.accepted', channels: ['email'], vars: { agreementNo: ag.agreementNo, commissionPercent: percent.toFixed(2), propertyRef: target.ref, acceptedAt: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) } });
  return ag;
}

// Make an accepted (pending) version the active one; supersede the previous.
async function activate(agreementId, previousId) {
  const ag = await Agreement.findById(agreementId);
  if (!ag.effectiveFrom) { ag.effectiveFrom = new Date(); await ag.save(); }
  if (previousId && String(previousId) !== String(agreementId)) {
    await Agreement.updateOne({ _id: previousId, status: { $in: ['accepted', 'countersigned'] } }, { $set: { status: 'superseded', supersededAt: new Date() } });
  }
  return ag;
}

const voidPending = (agreementId) => Agreement.updateOne({ _id: agreementId, status: 'accepted', effectiveFrom: null }, { $set: { status: 'void' } });

// ---------------------------------------------------------------- registry

function list(query, { listerId } = {}) {
  const filter = {};
  if (listerId) filter.listerId = listerId;
  if (query.status) filter.status = query.status;
  if (query.propertyId) filter.propertyId = query.propertyId;
  if (query.projectId) filter.projectId = query.projectId;
  if (query.listerId && !listerId) filter.listerId = query.listerId;
  return paginate(Agreement, filter, query, { projection: '-textSnapshot', populate: { path: 'listerId', select: 'name email' } });
}

async function get(id, { listerId } = {}) {
  const ag = await Agreement.findOne({ _id: id, ...(listerId ? { listerId } : {}) }).lean();
  if (!ag) throw ApiError.notFound('Agreement not found');
  const versions = await Agreement.find(ag.propertyId ? { propertyId: ag.propertyId } : { projectId: ag.projectId }).select('agreementNo version status commissionPercent acceptedAt effectiveFrom supersededAt').sort({ version: -1 }).lean();
  return { ...ag, hashValid: sha256(ag.textSnapshot) === ag.textHash, versions };
}

// Agreement PDF generated on demand from the immutable text snapshot.
async function pdf(id, res, { listerId } = {}) {
  const ag = await get(id, { listerId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${ag.agreementNo}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);
  doc.fontSize(16).text(`Commission Agreement ${ag.agreementNo} (version ${ag.version})`);
  doc.moveDown().fontSize(10).text(ag.textSnapshot, { align: 'left' });
  doc.moveDown().fontSize(8).fillColor('#555')
    .text(`Accepted by ${ag.acceptedName} at ${new Date(ag.acceptedAt).toISOString()} from IP ${ag.ip}. Status: ${ag.status}. Text SHA-256: ${ag.textHash}`);
  doc.end();
}

async function uploadSigned(id, body, req) {
  const ag = await Agreement.findById(id);
  if (!ag) throw ApiError.notFound('Agreement not found');
  const file = await storage.FileModel.findOne({ _id: body.fileId, purpose: 'signed_agreement' });
  if (!file) throw ApiError.badRequest('Upload the signed PDF first (purpose signed_agreement)', 'FILE_NOT_FOUND');
  assertTransition('agreement', ag.status, 'countersigned');
  ag.status = 'countersigned';
  ag.signedDocument = { fileId: file._id, uploadedBy: req.user._id, signedDate: body.signedDate ? new Date(body.signedDate) : new Date() };
  await ag.save();
  await audit(req, { action: 'agreement.countersign', entityType: 'Agreement', entityId: ag._id });
  const lister = await User.findById(ag.listerId);
  await notifyUser({ user: lister, event: 'agreement.countersigned', channels: ['in_app', 'email'], vars: { agreementNo: ag.agreementNo, agreementId: String(ag._id) } });
  return ag;
}

async function terminate(id, { reason }, req) {
  if (!reason || reason.length < 3) throw ApiError.validation([{ in: 'body', path: 'reason', message: 'A reason is required' }]);
  const ag = await Agreement.findById(id);
  if (!ag) throw ApiError.notFound('Agreement not found');
  assertTransition('agreement', ag.status, 'terminated');
  ag.status = 'terminated';
  ag.terminatedReason = reason;
  await ag.save();
  if (ag.propertyId) {
    const { Property } = require('../listings/models');
    const p = await Property.findById(ag.propertyId);
    if (p && String(p.activeAgreementId) === String(ag._id) && ['live', 'paused'].includes(p.status)) {
      p.statusHistory.push({ from: p.status, to: 'inactive', actor: req.user._id, note: 'Agreement terminated' });
      p.status = 'inactive';
      p.inactiveReason = 'agreement_terminated';
      await p.save();
    }
  }
  await audit(req, { action: 'agreement.terminate', entityType: 'Agreement', entityId: ag._id, reason });
  const lister = await User.findById(ag.listerId);
  await notifyUser({ user: lister, event: 'agreement.terminated', channels: ['in_app', 'email'], vars: { agreementNo: ag.agreementNo, reason, agreementId: String(ag._id) } });
  return ag;
}

async function requestNewVersion(id, { note }, req) {
  const ag = await Agreement.findById(id);
  if (!ag) throw ApiError.notFound('Agreement not found');
  const lister = await User.findById(ag.listerId);
  await notifyUser({ user: lister, event: 'agreement.new_version_requested', channels: ['in_app', 'email'], vars: { propertyRef: ag.agreementNo, note: note || '' } });
  await audit(req, { action: 'agreement.request_new_version', entityType: 'Agreement', entityId: ag._id, reason: note });
  return { requested: true };
}

// One CSV row per agreement version (acceptance D6).
async function exportCsv(res) {
  const rows = await Agreement.find().sort({ createdAt: 1 }).populate('listerId', 'name email').lean();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['agreementNo', 'version', 'status', 'listerName', 'listerEmail', 'propertyId', 'projectId', 'commissionPercent', 'basis', 'acceptedName', 'acceptedAt', 'ip', 'templateVersion', 'textHash'];
  const lines = rows.map((r) => [r.agreementNo, r.version, r.status, r.listerId && r.listerId.name, r.listerId && r.listerId.email, r.propertyId, r.projectId, r.commissionPercent, r.basis, r.acceptedName, r.acceptedAt && r.acceptedAt.toISOString(), r.ip, r.templateVersion, r.textHash].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="agreements.csv"');
  res.send([header.join(','), ...lines].join('\n'));
}

module.exports = { accept, activate, voidPending, assertPercent, commissionLimits, list, get, pdf, uploadSigned, terminate, requestNewVersion, exportCsv, render };
