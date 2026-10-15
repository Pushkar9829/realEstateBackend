// Human-readable sequence numbers. Invoice numbers are gapless per financial
// year as GST requires: RE/INV/<FY>/<seq>, allocated inside the same
// transaction as the invoice so an aborted transaction does not burn a number.
const mongoose = require('mongoose');

const Counter = mongoose.model('Counter', new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } }));

async function next(key, { session } = {}) {
  const doc = await Counter.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return doc.seq;
}

const pad = (n, w) => String(n).padStart(w, '0');
const yy = (d = new Date()) => String(d.getFullYear()).slice(2);

// Indian financial year label for a date: Apr 2026 - Mar 2027 -> "2026-27"
function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}

module.exports = {
  Counter,
  next,
  financialYear,
  listingNo: async (o) => `RE${yy()}-${pad(await next('listing', o), 6)}`,
  projectNo: async (o) => `PRJ${yy()}-${pad(await next('project', o), 5)}`,
  leadNo: async (o) => `LD${yy()}-${pad(await next('lead', o), 6)}`,
  dealNo: async (o) => `DL${yy()}-${pad(await next('deal', o), 5)}`,
  brokerFlagNo: async (o) => `BF${yy()}-${pad(await next('brokerflag', o), 5)}`,
  soldElsewhereNo: async (o) => `SE${yy()}-${pad(await next('soldelsewhere', o), 5)}`,
  agreementNo: async (o) => `AG${yy()}-${pad(await next('agreement', o), 6)}`,
  visitNo: async (o) => `SV${yy()}-${pad(await next('sitevisit', o), 6)}`,
  offerNo: async (o) => `OF${yy()}-${pad(await next('offer', o), 5)}`,
  reportNo: async (o) => `LR${yy()}-${pad(await next('listingreport', o), 5)}`,
  verificationNo: async (o) => `VS${yy()}-${pad(await next('verification', o), 5)}`,
  seekerFlagNo: async (o) => `SF${yy()}-${pad(await next('seekerflag', o), 5)}`,
  verificationVisitNo: async (o) => `VV${yy()}-${pad(await next('verificationvisit', o), 5)}`,
  receivableNo: async (o) => `R-${new Date().getFullYear()}-${pad(await next(`receivable:${new Date().getFullYear()}`, o), 5)}`,
  partnerReferralNo: async (o) => `PRF-${new Date().getFullYear()}-${pad(await next(`partnerreferral:${new Date().getFullYear()}`, o), 5)}`,
  invoiceNo: async (o) => {
    const fy = financialYear();
    return `RE/INV/${fy}/${pad(await next(`invoice:${fy}`, o), 5)}`;
  },
  creditNoteNo: async (o) => {
    const fy = financialYear();
    return `RE/CN/${fy}/${pad(await next(`creditnote:${fy}`, o), 5)}`;
  },
};
