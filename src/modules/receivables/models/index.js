// Module I - Commission Receivables & Invoicing. One receivable per verified
// deal; GST invoices (gapless numbers), payments, lister proofs, disputes.
// All amounts in paise.
const mongoose = require('mongoose');
const { STATUS } = require('../../../constants/status');

const { ObjectId } = mongoose.Schema.Types;

const invoiceSchema = new mongoose.Schema({
  invoiceNo: { type: String, required: true },
  date: { type: Date, default: Date.now },
  dueDate: Date,
  placeOfSupply: String,
  taxable: Number,
  cgst: Number,
  sgst: Number,
  igst: Number,
  total: Number,
  status: { type: String, enum: ['draft', 'issued', 'cancelled'], default: 'draft' },
  sacCode: String,
  billing: { name: String, gstin: String, address: String, state: String },
  pdfFileId: ObjectId,
  creditNote: { no: String, date: Date, reason: String },
}, { _id: true });

const paymentSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  tds: { type: Number, default: 0 },
  date: Date,
  mode: { type: String, enum: ['bank_transfer', 'upi', 'cheque', 'cash', 'other'] },
  reference: String, // UTR
  proofFileId: ObjectId,
  source: { type: String, enum: ['admin', 'lister'], required: true },
  status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  rejectReason: String,
  confirmedBy: ObjectId,
  confirmedAt: Date,
}, { _id: true, timestamps: true });

const receivableSchema = new mongoose.Schema({
  receivableNo: { type: String, required: true, unique: true },
  dealId: { type: ObjectId, ref: 'Deal', required: true, unique: true },
  listerId: { type: ObjectId, ref: 'User', required: true, index: true },
  propertyId: ObjectId,
  agentId: ObjectId,
  teamId: ObjectId,
  dealNo: String,
  interState: Boolean,
  commissionAmount: Number,
  gstAmount: Number,
  totalDue: Number,
  receivedAmount: { type: Number, default: 0 },
  tdsAmount: { type: Number, default: 0 },
  writtenOffAmount: { type: Number, default: 0 },
  status: { type: String, enum: STATUS.commissionReceivable.values, default: 'pending_invoice', index: true },
  dueDate: { type: Date, index: true },
  invoices: [invoiceSchema],
  payments: [paymentSchema],
  dispute: { reason: String, raisedBy: ObjectId, raisedByRole: String, raisedAt: Date, previousStatus: String, invoiceId: ObjectId, resolvedNote: String, resolvedAt: Date },
  writeOff: { reason: String, by: ObjectId, at: Date, amount: Number, partial: Boolean }, // the latest write-off; every one is on the timeline
  remindersSent: [{ _id: false, kind: String, at: Date }],
  timeline: [{ _id: false, type: { type: String }, by: ObjectId, at: { type: Date, default: Date.now }, note: String }],
}, { timestamps: true });
receivableSchema.index({ 'invoices.invoiceNo': 1 }, { unique: true, sparse: true });

module.exports = { Receivable: mongoose.model('Receivable', receivableSchema) };
