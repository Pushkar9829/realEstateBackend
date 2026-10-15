// Module I - commission receivables and GST invoicing (spec 4.9).
// One receivable per verified deal (created inside the verify transaction).
// Invoices are drafted, then issued with a gapless per-FY number allocated in
// the issuing transaction; payments (admin or confirmed lister proofs) and TDS
// reduce the outstanding; disputes pause collection; a full write-off closes
// it and a partial one reduces the outstanding.
// Amounts are paise in the DB and rupees in request bodies.
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const { z } = require('zod');
const { Receivable } = require('./models');
const { User } = require('../auth/models');
const counters = require('../../core/counters');
const settings = require('../../core/settings');
const storage = require('../../core/storage');
const events = require('../../core/events');
const { toPaise, toRupees, percentOf } = require('../../core/money');
const { ApiError, paginate } = require('../../core/http');
const { audit } = require('../../core/audit');
const { notifyUser, notifyPermission } = require('../notifications/service');
const reveal = require('../masking/reveal.service');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const OPEN = ['pending_invoice', 'invoiced', 'overdue', 'partially_paid'];
const COLLECTING = ['invoiced', 'overdue', 'partially_paid'];
const DAY = 86400000;
const inr = (paise) => toRupees(paise || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const field = (path, message) => ApiError.validation([{ in: 'body', path, message }]);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const istDay = (d) => Math.floor((new Date(d).getTime() + 330 * 60000) / DAY);

// ---------------------------------------------------------------- figures

const issued = (r) => r.invoices.filter((i) => i.status === 'issued');
const live = (r) => r.invoices.filter((i) => i.status !== 'cancelled');
const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] || 0), 0);
const paid = (r) => (r.receivedAmount || 0) + (r.tdsAmount || 0);
// A cancelled receivable (deal reversed before any payment) owes nothing.
const outstanding = (r) => (r.status === 'cancelled' ? 0 : Math.max(0, (r.totalDue || 0) - paid(r) - (r.writtenOffAmount || 0)));
const collectible = (r) => Math.max(0, sum(issued(r), 'total') - paid(r) - (r.writtenOffAmount || 0));

function figures(r) {
  return {
    invoicedTotal: sum(issued(r), 'total'),
    uninvoicedCommission: Math.max(0, (r.commissionAmount || 0) - sum(live(r), 'taxable')),
    paidTotal: paid(r),
    outstanding: outstanding(r),
    collectible: collectible(r),
  };
}

// Status from the money (payments, invoices), used after payments, cancels and dispute resolution.
function derive(r, now = new Date()) {
  if (paid(r) > 0 && outstanding(r) === 0) return 'paid';
  const past = issued(r).some((i) => i.dueDate && i.dueDate < now) && collectible(r) > 0;
  if (paid(r) > 0) return past ? 'overdue' : 'partially_paid';
  if (issued(r).length) return past ? 'overdue' : 'invoiced';
  return 'pending_invoice';
}

function setStatus(r, to, by, note) {
  if (r.status === to) return;
  r.timeline.push({ type: 'status', by, at: new Date(), note: `${r.status} -> ${to}${note ? `: ${note}` : ''}` });
  r.status = to;
}

function earliestDue(r) {
  const dues = issued(r).map((i) => i.dueDate).filter(Boolean).sort((a, b) => a - b);
  return dues[0];
}

async function gstSplit(taxable, billingState) {
  const [percent, companyState] = await Promise.all([settings.get('invoice.gstPercent'), settings.get('company.state')]);
  const interState = String(billingState || companyState).trim().toLowerCase() !== String(companyState).trim().toLowerCase();
  const gst = percentOf(taxable, percent);
  const half = Math.floor(gst / 2);
  return interState ? { interState, cgst: 0, sgst: 0, igst: gst, total: taxable + gst, percent } : { interState, cgst: half, sgst: gst - half, igst: 0, total: taxable + gst, percent };
}

// ---------------------------------------------------------------- deal hooks (called inside the deal transactions)

async function createFromDeal(deal, { session } = {}) {
  if (await Receivable.exists({ dealId: deal._id }).session(session)) throw ApiError.conflict('A receivable already exists for this deal', 'RECEIVABLE_EXISTS');
  const [rec] = await Receivable.create([{
    receivableNo: await counters.receivableNo({ session }), dealId: deal._id, dealNo: deal.dealNo, listerId: deal.listerId, propertyId: deal.propertyId || deal.projectId,
    agentId: deal.agentId, teamId: deal.teamId, interState: deal.gst && deal.gst.interState,
    commissionAmount: deal.commissionAmount, gstAmount: deal.gstAmount, totalDue: (deal.commissionAmount || 0) + (deal.gstAmount || 0),
    status: 'pending_invoice', timeline: [{ type: 'created', by: deal.review && deal.review.verifiedBy, at: new Date(), note: `Deal ${deal.dealNo} verified` }],
  }], { session });
  return rec;
}

// H2: no payments -> cancelled (issued invoices get credit notes); payments -> disputed.
async function onDealReversed(deal, reason, by, { session } = {}) {
  const r = await Receivable.findOne({ dealId: deal._id }).session(session);
  if (!r) return null;
  if (paid(r) > 0) {
    r.dispute = { reason: `Deal reversed: ${reason}. Refund or credit note needed.`, raisedBy: by, raisedByRole: 'system', raisedAt: new Date(), previousStatus: r.status };
    setStatus(r, 'disputed', by, 'Deal reversed with payments received');
  } else {
    r.invoices = r.invoices.filter((i) => i.status !== 'draft');
    for (const inv of issued(r)) {
      inv.status = 'cancelled';
      inv.creditNote = { no: await counters.creditNoteNo({ session }), date: new Date(), reason: `Deal ${deal.dealNo} reversed` };
    }
    setStatus(r, 'cancelled', by, 'Deal reversed');
  }
  await r.save({ session });
  return r;
}

// ---------------------------------------------------------------- admin

async function scope(user) {
  if (user.role !== 'manager') return {};
  return { teamId: { $in: await reveal.managedTeamIds(user) } };
}

async function rec(user, id) {
  if (!oid.safeParse(String(id)).success) throw ApiError.notFound('Receivable not found');
  const r = await Receivable.findOne({ _id: id, ...(await scope(user)) });
  if (!r) throw ApiError.notFound('Receivable not found');
  return r;
}

async function byInvoice(invoiceId, extra = {}) {
  if (!oid.safeParse(String(invoiceId)).success) throw ApiError.notFound('Invoice not found');
  const r = await Receivable.findOne({ 'invoices._id': invoiceId, ...extra });
  if (!r) throw ApiError.notFound('Invoice not found');
  return { r, inv: r.invoices.id(invoiceId) };
}

async function listFilter(user, query) {
  const filter = await scope(user);
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.listerId) filter.listerId = query.listerId;
  if (query.agentId) filter.agentId = query.agentId;
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ receivableNo: rx }, { dealNo: rx }, { 'invoices.invoiceNo': rx }];
  }
  if (query.from || query.to) filter.createdAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  return filter;
}

async function list(user, query) {
  const r = await paginate(Receivable, await listFilter(user, query), query, { projection: '-timeline', populate: [{ path: 'listerId', select: 'name billing.name' }] });
  r.items = r.items.map((x) => ({ ...x, ...figures(x), pendingProofs: (x.payments || []).filter((p) => p.status === 'pending').length }));
  return r;
}

async function exportCsv(user, query, res) {
  const rows = await Receivable.find(await listFilter(user, query)).populate('listerId', 'name billing.name').sort({ createdAt: -1 }).limit(10000).lean();
  const esc = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['receivableNo', 'dealNo', 'lister', 'status', 'commission', 'gst', 'totalDue', 'received', 'tds', 'writtenOff', 'outstanding', 'invoices', 'dueDate', 'createdAt'];
  const lines = rows.map((x) => [x.receivableNo, x.dealNo, (x.listerId && ((x.listerId.billing && x.listerId.billing.name) || x.listerId.name)) || '', x.status,
    toRupees(x.commissionAmount), toRupees(x.gstAmount), toRupees(x.totalDue), toRupees(x.receivedAmount), toRupees(x.tdsAmount), toRupees(x.writtenOffAmount), toRupees(outstanding(x)),
    (x.invoices || []).filter((i) => i.status === 'issued').map((i) => i.invoiceNo).join(' '), x.dueDate ? new Date(x.dueDate).toISOString().slice(0, 10) : '', new Date(x.createdAt).toISOString()].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="receivables-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send([head.join(','), ...lines].join('\n'));
}

async function withProofUrls(r) {
  const o = r.toObject();
  const ids = o.payments.map((p) => p.proofFileId).filter(Boolean);
  const files = ids.length ? await storage.FileModel.find({ _id: { $in: ids } }) : [];
  o.payments = o.payments.map((p) => { const f = files.find((x) => String(x._id) === String(p.proofFileId)); return { ...p, proofUrl: f ? storage.urlFor(f, 600) : null }; });
  return o;
}

async function detail(user, id) {
  const r = await rec(user, id);
  const { Deal } = require('../deals/models');
  const [deal, lister] = await Promise.all([
    Deal.findById(r.dealId).select('dealNo dealType agreedPrice monthlyRent commissionPercent commissionBasis commissionAmount gstAmount gst bookingDate status propertyId projectId agentId').populate('propertyId', 'listingNo title').populate('projectId', 'projectNo name').populate('agentId', 'name').lean(),
    User.findById(r.listerId).select('name listerType billing email').lean(),
  ]);
  return { ...(await withProofUrls(r)), ...figures(r), deal, lister };
}

const draftSchema = z.object({ amount: z.coerce.number().positive().max(1e9).optional(), note: z.string().trim().max(500).optional() });

async function draftInvoice(user, id, body, req) {
  const d = draftSchema.parse(body);
  const r = await rec(user, id);
  if (['cancelled', 'written_off', 'disputed', 'paid'].includes(r.status)) throw ApiError.conflict(`A ${r.status.replace('_', ' ')} receivable cannot be invoiced`, 'RECEIVABLE_CLOSED');
  const lister = await User.findById(r.listerId);
  if (!lister.billing || !lister.billing.name) {
    await notifyUser({ user: lister, event: 'billing.required', vars: { dealNo: r.dealNo }, channels: ['in_app', 'email'] });
    throw ApiError.validation([{ in: 'body', path: 'billing', message: 'Billing name required' }], 'Billing name required');
  }
  const remaining = Math.max(0, r.commissionAmount - sum(live(r), 'taxable'));
  const taxable = d.amount !== undefined ? toPaise(d.amount) : remaining;
  if (!remaining || !taxable) throw ApiError.conflict('The full commission is already invoiced', 'FULLY_INVOICED');
  const split = await gstSplit(taxable, lister.billing.state || (lister.address && lister.address.state));
  if (sum(live(r), 'total') + split.total > r.totalDue) throw field('amount', `Invoices cannot exceed the commission plus GST (INR ${inr(r.totalDue)}); INR ${inr(remaining)} of commission is left to invoice`);
  const inv = r.invoices.create({
    invoiceNo: `DRAFT-${new mongoose.Types.ObjectId()}`, status: 'draft', date: new Date(), taxable, cgst: split.cgst, sgst: split.sgst, igst: split.igst, total: split.total,
    placeOfSupply: lister.billing.state || (lister.address && lister.address.state), sacCode: String(await settings.get('invoice.sacCode')),
    billing: { name: lister.billing.name, gstin: lister.billing.gstin, address: lister.billing.address, state: lister.billing.state },
  });
  r.invoices.push(inv);
  r.timeline.push({ type: 'invoice_draft', by: user._id, at: new Date(), note: `Draft INR ${inr(split.total)}${d.note ? `: ${d.note}` : ''}` });
  await r.save();
  await audit(req, { action: 'invoice.draft', entityType: 'Receivable', entityId: r._id, after: { taxable, total: split.total } });
  return { receivableId: r._id, invoice: r.invoices.id(inv._id), ...figures(r) };
}

const issueSchema = z.object({ dueDays: z.coerce.number().int().min(1).max(180).optional() });

async function issue(user, invoiceId, body, req) {
  const d = issueSchema.parse(body || {});
  const session = await mongoose.startSession();
  let out;
  try {
    await session.withTransaction(async () => {
      const r = await Receivable.findOne({ 'invoices._id': invoiceId, ...(await scope(user)) }).session(session);
      if (!r) throw ApiError.notFound('Invoice not found');
      const inv = r.invoices.id(invoiceId);
      if (inv.status !== 'draft') throw ApiError.conflict(`The invoice is already ${inv.status}`, 'INVOICE_NOT_DRAFT');
      if (['cancelled', 'written_off', 'disputed'].includes(r.status)) throw ApiError.conflict(`A ${r.status.replace('_', ' ')} receivable cannot be invoiced`, 'RECEIVABLE_CLOSED');
      const now = new Date();
      const dueDays = d.dueDays || await settings.get('invoice.dueDays');
      inv.invoiceNo = await counters.invoiceNo({ session }); // gapless: aborted transactions do not burn a number
      inv.status = 'issued';
      inv.date = now;
      inv.dueDate = new Date(now.getTime() + dueDays * DAY);
      if (r.status === 'pending_invoice') setStatus(r, 'invoiced', user._id, `Invoice ${inv.invoiceNo}`);
      r.dueDate = earliestDue(r);
      r.timeline.push({ type: 'invoice_issued', by: user._id, at: now, note: inv.invoiceNo });
      await r.save({ session });
      await audit(req, { action: 'invoice.issue', entityType: 'Receivable', entityId: r._id, after: { invoiceNo: inv.invoiceNo, total: inv.total } }, { session });
      out = { r, inv };
    });
  } finally {
    await session.endSession();
  }
  const { r, inv } = out;
  if (await settings.get('invoice.eInvoicingEnabled')) r.timeline.push({ type: 'einvoice', at: new Date(), note: 'IRN request pending (integration not configured)' });
  const lister = await User.findById(r.listerId);
  if (lister) await notifyUser({ user: lister, event: 'invoice.issued', vars: { invoiceNo: inv.invoiceNo, invoiceId: String(inv._id), total: inr(inv.total), dueDate: fmtDate(inv.dueDate), link: `/lister/invoices/${inv._id}` }, channels: ['in_app', 'email'] });
  events.emit(events.EVENTS.INVOICE_ISSUED, { receivableId: r._id, invoiceNo: inv.invoiceNo });
  return { receivableId: r._id, status: r.status, invoice: inv, ...figures(r) };
}

const cancelSchema = z.object({ reason: z.string().trim().min(5).max(500) });

async function cancelInvoice(user, invoiceId, body, req) {
  const { reason } = cancelSchema.parse(body);
  const session = await mongoose.startSession();
  let out;
  try {
    await session.withTransaction(async () => {
      const r = await Receivable.findOne({ 'invoices._id': invoiceId, ...(await scope(user)) }).session(session);
      if (!r) throw ApiError.notFound('Invoice not found');
      const inv = r.invoices.id(invoiceId);
      if (inv.status === 'cancelled') throw ApiError.conflict('The invoice is already cancelled', 'INVOICE_CANCELLED');
      if (inv.status === 'draft') { inv.deleteOne(); await r.save({ session }); out = { r, inv: null }; return; }
      if (sum(issued(r), 'total') - inv.total < paid(r)) throw ApiError.conflict('Payments already received exceed the remaining invoices; record a refund first', 'PAYMENTS_EXCEED');
      inv.status = 'cancelled';
      inv.creditNote = { no: await counters.creditNoteNo({ session }), date: new Date(), reason };
      r.timeline.push({ type: 'credit_note', by: user._id, at: new Date(), note: `${inv.creditNote.no} for ${inv.invoiceNo}: ${reason}` });
      if (!['disputed', 'written_off', 'cancelled'].includes(r.status)) setStatus(r, derive(r), user._id, `Invoice ${inv.invoiceNo} cancelled`);
      r.dueDate = earliestDue(r);
      await r.save({ session });
      await audit(req, { action: 'invoice.cancel', entityType: 'Receivable', entityId: r._id, reason, after: { invoiceNo: inv.invoiceNo, creditNote: inv.creditNote.no } }, { session });
      out = { r, inv };
    });
  } finally {
    await session.endSession();
  }
  if (out.inv) {
    const lister = await User.findById(out.r.listerId);
    if (lister) await notifyUser({ user: lister, event: 'invoice.cancelled', vars: { invoiceNo: out.inv.invoiceNo, creditNoteNo: out.inv.creditNote.no, reason }, channels: ['in_app', 'email'] });
  }
  return { receivableId: out.r._id, status: out.r.status, invoice: out.inv, ...figures(out.r) };
}

// Tax invoice PDF (pdfkit, rendered on demand from the stored figures).
async function pdf(invoiceId, res, { listerId } = {}) {
  const { r, inv } = await byInvoice(invoiceId, listerId ? { listerId } : {});
  if (inv.status === 'draft' && listerId) throw ApiError.notFound('Invoice not found');
  const [company, gstin] = await Promise.all([settings.get('general.companyName').catch(() => 'Real Estate Platform'), settings.get('company.gstin')]);
  const companyState = await settings.get('company.state');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNo.replace(/\//g, '-')}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);
  doc.fontSize(18).text(inv.status === 'draft' ? 'DRAFT TAX INVOICE' : 'TAX INVOICE', { align: 'right' });
  doc.fontSize(10).text(company || '', 50, 50).text(`GSTIN: ${gstin || 'not registered'}`).text(`State: ${companyState}`);
  doc.moveDown(2);
  doc.text(`Invoice no: ${inv.invoiceNo}`).text(`Date: ${fmtDate(inv.date)}`).text(`Due date: ${fmtDate(inv.dueDate)}`).text(`Receivable: ${r.receivableNo}   Deal: ${r.dealNo}`);
  doc.moveDown().fontSize(11).text('Bill to', { underline: true }).fontSize(10)
    .text(inv.billing && inv.billing.name).text((inv.billing && inv.billing.address) || '').text(`GSTIN: ${(inv.billing && inv.billing.gstin) || 'unregistered'}`).text(`Place of supply: ${inv.placeOfSupply || ''}`);
  doc.moveDown().fontSize(11).text('Particulars', { underline: true }).fontSize(10)
    .text(`Channel sales partner commission on deal ${r.dealNo} (SAC ${inv.sacCode || ''})`)
    .text(`Taxable value: INR ${inr(inv.taxable)}`);
  if (inv.igst) doc.text(`IGST: INR ${inr(inv.igst)}`);
  else doc.text(`CGST: INR ${inr(inv.cgst)}`).text(`SGST: INR ${inr(inv.sgst)}`);
  doc.fontSize(12).text(`Total: INR ${inr(inv.total)}`);
  if (inv.status === 'cancelled' && inv.creditNote) doc.moveDown().fillColor('#b00').fontSize(11).text(`CANCELLED - credit note ${inv.creditNote.no} dated ${fmtDate(inv.creditNote.date)}: ${inv.creditNote.reason}`).fillColor('#000');
  doc.moveDown(2).fontSize(8).fillColor('#555').text('This is a computer generated invoice.');
  doc.end();
}

const paymentSchema = z.object({
  amount: z.coerce.number().min(0).max(1e9),
  tds: z.coerce.number().min(0).max(1e9).default(0),
  date: z.coerce.date().default(() => new Date()),
  mode: z.enum(['bank_transfer', 'upi', 'cheque', 'cash', 'other']),
  reference: z.string().trim().max(80).optional(),
  proofFileId: oid.optional(),
}).refine((d) => d.amount + d.tds > 0, 'Enter the amount received or TDS');

function applyPayment(r, amount, tds, by) {
  if (!COLLECTING.includes(r.status)) {
    if (r.status === 'disputed') throw ApiError.conflict('Collection is paused while the receivable is disputed', 'DISPUTED');
    throw ApiError.conflict(r.status === 'pending_invoice' ? 'Issue an invoice before recording payments' : `A ${r.status.replace('_', ' ')} receivable takes no payments`, 'NOT_COLLECTING');
  }
  if (amount + tds > collectible(r)) throw field('amount', `The payment exceeds the outstanding on issued invoices (INR ${inr(collectible(r))})`);
  r.receivedAmount = (r.receivedAmount || 0) + amount;
  r.tdsAmount = (r.tdsAmount || 0) + tds;
  setStatus(r, paid(r) >= r.totalDue - (r.writtenOffAmount || 0) ? 'paid' : 'partially_paid', by, `INR ${inr(amount)} received${tds ? `, TDS ${inr(tds)}` : ''}`);
}

async function paymentReceipt(r, amount) {
  const lister = await User.findById(r.listerId);
  if (lister) await notifyUser({ user: lister, event: 'payment.confirmed', vars: { amount: inr(amount), receivableNo: r.receivableNo, outstanding: inr(outstanding(r)) }, channels: ['in_app', 'email'] });
  events.emit(events.EVENTS.PAYMENT_CONFIRMED, { receivableId: r._id, amount });
}

async function recordPayment(user, id, body, req) {
  const d = paymentSchema.parse(body);
  const r = await rec(user, id);
  const amount = toPaise(d.amount);
  const tds = toPaise(d.tds);
  applyPayment(r, amount, tds, user._id);
  r.payments.push({ amount, tds, date: d.date, mode: d.mode, reference: d.reference, proofFileId: d.proofFileId, source: 'admin', status: 'confirmed', confirmedBy: user._id, confirmedAt: new Date() });
  await r.save();
  await audit(req, { action: 'receivable.payment', entityType: 'Receivable', entityId: r._id, after: { amount, tds, mode: d.mode, reference: d.reference } });
  await paymentReceipt(r, amount);
  return { status: r.status, ...figures(r), payment: r.payments[r.payments.length - 1] };
}

const proofDecisionSchema = z.object({ decision: z.enum(['confirm', 'reject']), amount: z.coerce.number().min(0).optional(), tds: z.coerce.number().min(0).optional(), reason: z.string().trim().max(500).optional() });

async function decideProof(user, id, proofId, body, req) {
  const d = proofDecisionSchema.parse(body);
  const r = await rec(user, id);
  const p = r.payments.id(proofId);
  if (!p || p.source !== 'lister') throw ApiError.notFound('Payment proof not found');
  if (p.status !== 'pending') throw ApiError.conflict(`The proof is already ${p.status}`, 'PROOF_DECIDED');
  const lister = await User.findById(r.listerId);
  if (d.decision === 'reject') {
    if (!d.reason || d.reason.length < 5) throw field('reason', 'Tell the lister why the proof is not accepted');
    p.status = 'rejected';
    p.rejectReason = d.reason;
    r.timeline.push({ type: 'proof_rejected', by: user._id, at: new Date(), note: d.reason });
    await r.save();
    await audit(req, { action: 'receivable.proof.reject', entityType: 'Receivable', entityId: r._id, reason: d.reason });
    if (lister) await notifyUser({ user: lister, event: 'payment.proof_rejected', vars: { receivableNo: r.receivableNo, reason: d.reason }, channels: ['in_app', 'email'] });
    return { status: r.status, payment: p, ...figures(r) };
  }
  // Confirm the actual bank credit, which may differ from the claimed amount.
  const amount = d.amount !== undefined ? toPaise(d.amount) : p.amount;
  const tds = d.tds !== undefined ? toPaise(d.tds) : p.tds || 0;
  applyPayment(r, amount, tds, user._id);
  Object.assign(p, { amount, tds, status: 'confirmed', confirmedBy: user._id, confirmedAt: new Date() });
  await r.save();
  await audit(req, { action: 'receivable.proof.confirm', entityType: 'Receivable', entityId: r._id, after: { amount, tds } });
  await paymentReceipt(r, amount);
  return { status: r.status, payment: p, ...figures(r) };
}

const disputeSchema = z.object({ reason: z.string().trim().min(10).max(1000), invoiceId: oid.optional() });

async function raiseDispute(r, d, by, role) {
  if (!OPEN.includes(r.status)) throw ApiError.conflict(`A ${r.status.replace('_', ' ')} receivable cannot be disputed`, 'INVALID_TRANSITION');
  r.dispute = { reason: d.reason, invoiceId: d.invoiceId, raisedBy: by, raisedByRole: role, raisedAt: new Date(), previousStatus: r.status };
  setStatus(r, 'disputed', by, d.reason);
  await r.save();
  const who = role === 'lister' ? 'The lister' : 'Finance';
  await notifyPermission('receivables.manage', 'invoice.disputed', { receivableNo: r.receivableNo, receivableId: String(r._id), reason: d.reason, who }, ['in_app', 'email']);
  return r;
}

async function dispute(user, id, body, req) {
  const d = disputeSchema.parse(body);
  const r = await raiseDispute(await rec(user, id), d, user._id, 'admin');
  await audit(req, { action: 'receivable.dispute', entityType: 'Receivable', entityId: r._id, reason: d.reason });
  return { status: r.status, dispute: r.dispute };
}

const resolveSchema = z.object({ note: z.string().trim().min(5).max(1000) });

async function resolve(user, id, body, req) {
  const { note } = resolveSchema.parse(body);
  const r = await rec(user, id);
  if (r.status !== 'disputed') throw ApiError.conflict('The receivable is not disputed', 'NOT_DISPUTED');
  r.dispute.resolvedNote = note;
  r.dispute.resolvedAt = new Date();
  // Back to the previous status, recomputed from the money in case invoices changed meanwhile.
  setStatus(r, derive(r), user._id, `Dispute resolved: ${note}`);
  await r.save();
  await audit(req, { action: 'receivable.dispute.resolve', entityType: 'Receivable', entityId: r._id, reason: note });
  return { status: r.status, dispute: r.dispute, ...figures(r) };
}

// amount (rupees) is optional and defaults to the whole outstanding. A partial
// write-off keeps the receivable open (status recomputed from the money; a
// dispute stays open); writing off the rest sets written_off.
const writeOffSchema = z.object({ reason: z.string().trim().min(10).max(1000), amount: z.coerce.number().positive().max(1e9).optional() });

async function writeOff(user, id, body, req) {
  const d = writeOffSchema.parse(body);
  const { reason } = d;
  const r = await rec(user, id);
  if (![...OPEN, 'disputed'].includes(r.status)) throw ApiError.conflict(`A ${r.status.replace('_', ' ')} receivable cannot be written off`, 'INVALID_TRANSITION');
  const remaining = outstanding(r);
  const amount = d.amount === undefined ? remaining : toPaise(d.amount);
  if (amount > remaining) throw field('amount', `At most the outstanding (INR ${inr(remaining)})`);
  if (amount <= 0) throw ApiError.conflict('Nothing is outstanding to write off', 'NOTHING_OUTSTANDING');
  const partial = amount < remaining;
  r.writtenOffAmount = (r.writtenOffAmount || 0) + amount;
  r.writeOff = { reason, by: user._id, at: new Date(), amount, partial };
  const note = `INR ${inr(amount)} written off${partial ? ` (partial, INR ${inr(remaining - amount)} still due)` : ''}: ${reason}`;
  if (!partial) setStatus(r, 'written_off', user._id, note);
  else {
    r.timeline.push({ type: 'write_off', by: user._id, at: new Date(), note });
    if (r.status !== 'disputed') setStatus(r, derive(r), user._id, 'Recomputed after a partial write-off');
  }
  await r.save();
  await audit(req, { action: partial ? 'receivable.write_off.partial' : 'receivable.write_off', entityType: 'Receivable', entityId: r._id, reason, after: { amount, partial, outstanding: outstanding(r) } });
  return { status: r.status, writtenOffAmount: r.writtenOffAmount, partial, ...figures(r) };
}

// ---------------------------------------------------------------- reminders and overdue (RE-I-06)

async function sendReminder(r, when, kind) {
  const inv = issued(r).filter((i) => i.dueDate).sort((a, b) => a.dueDate - b.dueDate)[0];
  if (!inv) return false;
  const lister = await User.findById(r.listerId);
  if (!lister) return false;
  await notifyUser({ user: lister, event: 'invoice.reminder', vars: { invoiceNo: inv.invoiceNo, outstanding: inr(collectible(r)), dueDate: fmtDate(inv.dueDate), when, link: `/lister/invoices/${inv._id}` }, channels: ['email', 'sms'] });
  r.remindersSent.push({ kind, at: new Date() });
  return true;
}

const remindSchema = z.object({ ids: z.array(oid).max(500).optional() });

async function bulkRemind(user, body, req) {
  const d = remindSchema.parse(body || {});
  const filter = { ...(await scope(user)), status: { $in: COLLECTING } };
  if (d.ids && d.ids.length) filter._id = { $in: d.ids };
  const rows = await Receivable.find(filter);
  let sent = 0;
  for (const r of rows) {
    if (!collectible(r)) continue;
    const due = earliestDue(r);
    const days = due ? istDay(new Date()) - istDay(due) : 0;
    if (await sendReminder(r, days > 0 ? `${days} days overdue` : 'due soon', 'manual')) { sent += 1; await r.save(); }
  }
  await audit(req, { action: 'receivable.remind', entityType: 'Receivable', after: { sent } });
  return { sent, considered: rows.length };
}

// Daily: overdue status, reminders 3 days before due and 7 / 15 / 30 days after, 30-day escalation.
async function runDaily(now = new Date()) {
  const offsets = await settings.get('invoice.reminderOffsets');
  const rows = await Receivable.find({ status: { $in: COLLECTING }, dueDate: { $ne: null } });
  const escalate = [];
  let overdue = 0; let reminders = 0;
  for (const r of rows) {
    if (!collectible(r)) continue;
    const days = istDay(now) - istDay(r.dueDate);
    let changed = false;
    if (days > 0 && r.status !== 'overdue') { setStatus(r, 'overdue', undefined, 'Due date passed'); overdue += 1; changed = true; }
    const kind = `due${days}:${new Date(r.dueDate).toISOString().slice(0, 10)}`;
    if (offsets.includes(days) && !r.remindersSent.some((x) => x.kind === kind)) {
      if (await sendReminder(r, days < 0 ? `due in ${-days} days` : `${days} days overdue`, kind)) { reminders += 1; changed = true; }
    }
    if (days >= 30 && !r.remindersSent.some((x) => x.kind === 'escalated')) { escalate.push(r.receivableNo); r.remindersSent.push({ kind: 'escalated', at: now }); changed = true; }
    if (changed) await r.save();
  }
  if (escalate.length) await notifyPermission('receivables.manage', 'receivable.overdue_30', { count: escalate.length, list: escalate.join(', ') });
  return { overdue, reminders, escalated: escalate.length };
}

// ---------------------------------------------------------------- ageing (RE-I-08, used by reports)

async function ageing(user, now = new Date()) {
  const rows = await Receivable.find({ ...(await scope(user)), status: { $in: [...COLLECTING, 'disputed', 'pending_invoice'] } }).select('receivableNo status totalDue receivedAmount tdsAmount writtenOffAmount dueDate invoices createdAt').lean();
  const buckets = { current: 0, '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const counts = { current: 0, '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let uninvoiced = 0; let disputed = 0;
  for (const r of rows) {
    if (r.status === 'pending_invoice') { uninvoiced += r.totalDue; continue; }
    const amt = outstanding(r);
    if (r.status === 'disputed') { disputed += amt; continue; }
    const days = r.dueDate ? istDay(now) - istDay(r.dueDate) : -1;
    const b = days < 0 ? 'current' : days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
    buckets[b] += amt;
    counts[b] += 1;
  }
  return { buckets, counts, uninvoiced, disputed, total: Object.values(buckets).reduce((a, b) => a + b, 0) };
}

// ---------------------------------------------------------------- lister

function listerInvoice(r, inv) {
  return {
    _id: inv._id, invoiceNo: inv.invoiceNo, date: inv.date, dueDate: inv.dueDate, status: inv.status, taxable: inv.taxable, cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, total: inv.total,
    creditNote: inv.creditNote, receivableNo: r.receivableNo, dealNo: r.dealNo, receivableStatus: r.status, outstanding: collectible(r),
  };
}

async function listerInvoices(user, query) {
  const filter = { listerId: user._id, 'invoices.status': { $in: ['issued', 'cancelled'] } };
  const rows = await Receivable.find(filter).sort({ createdAt: -1 }).limit(500);
  let items = rows.flatMap((r) => r.invoices.filter((i) => i.status !== 'draft').map((i) => listerInvoice(r, i)));
  if (query.status) items = items.filter((i) => i.status === query.status || i.receivableStatus === query.status);
  const due = rows.filter((r) => COLLECTING.includes(r.status)).reduce((a, r) => a + collectible(r), 0);
  return { items, summary: { outstanding: due, overdue: rows.filter((r) => r.status === 'overdue').length } };
}

async function listerInvoiceDetail(user, invoiceId) {
  const { r, inv } = await byInvoice(invoiceId, { listerId: user._id });
  if (inv.status === 'draft') throw ApiError.notFound('Invoice not found');
  return {
    ...listerInvoice(r, inv), billing: inv.billing, placeOfSupply: inv.placeOfSupply, sacCode: inv.sacCode,
    payments: r.payments.map((p) => ({ _id: p._id, amount: p.amount, tds: p.tds, date: p.date, mode: p.mode, reference: p.reference, source: p.source, status: p.status, rejectReason: p.rejectReason })),
    dispute: r.status === 'disputed' ? { reason: r.dispute.reason, raisedAt: r.dispute.raisedAt } : null,
    canUploadProof: COLLECTING.includes(r.status), canDispute: OPEN.includes(r.status),
  };
}

const proofSchema = z.object({ fileId: oid, amount: z.coerce.number().positive().max(1e9), tds: z.coerce.number().min(0).max(1e9).default(0), date: z.coerce.date(), mode: z.enum(['bank_transfer', 'upi', 'cheque', 'cash', 'other']), reference: z.string().trim().max(80).optional() });

async function uploadProof(user, invoiceId, body, req) {
  const d = proofSchema.parse(body);
  const { r, inv } = await byInvoice(invoiceId, { listerId: user._id });
  if (inv.status !== 'issued') throw ApiError.conflict('Proofs can be added to issued invoices only', 'INVOICE_NOT_ISSUED');
  if (!COLLECTING.includes(r.status)) throw ApiError.conflict(r.status === 'disputed' ? 'Collection is paused while the invoice is disputed' : `The invoice is ${r.status.replace('_', ' ')}`, 'NOT_COLLECTING');
  const file = await storage.FileModel.findOne({ _id: d.fileId, ownerId: user._id, purpose: 'payment_proof' });
  if (!file) throw ApiError.badRequest('Upload the proof first (purpose payment_proof)', 'FILE_NOT_FOUND');
  file.attachedTo = { type: 'Receivable', id: r._id };
  r.payments.push({ amount: toPaise(d.amount), tds: toPaise(d.tds), date: d.date, mode: d.mode, reference: d.reference, proofFileId: file._id, source: 'lister', status: 'pending' });
  r.timeline.push({ type: 'proof', by: user._id, at: new Date(), note: `INR ${inr(toPaise(d.amount))} for ${inv.invoiceNo}` });
  await Promise.all([r.save(), file.save()]);
  await audit(req, { action: 'receivable.proof.upload', entityType: 'Receivable', entityId: r._id, after: { amount: toPaise(d.amount) } });
  await notifyPermission('receivables.manage', 'payment.proof_submitted', { receivableNo: r.receivableNo, receivableId: String(r._id), amount: inr(toPaise(d.amount)) });
  const p = r.payments[r.payments.length - 1];
  return { _id: p._id, status: p.status, amount: p.amount };
}

async function listerDispute(user, invoiceId, body, req) {
  const d = disputeSchema.parse({ ...body, invoiceId });
  const { r } = await byInvoice(invoiceId, { listerId: user._id });
  await raiseDispute(r, d, user._id, 'lister');
  await audit(req, { action: 'receivable.dispute', entityType: 'Receivable', entityId: r._id, reason: d.reason });
  return { status: r.status };
}

module.exports = {
  createFromDeal, onDealReversed, list, exportCsv, detail, draftInvoice, issue, cancelInvoice, pdf, recordPayment, decideProof,
  dispute, resolve, writeOff, bulkRemind, runDaily, ageing, listerInvoices, listerInvoiceDetail, uploadProof, listerDispute,
  outstanding, figures, OPEN, COLLECTING,
};
