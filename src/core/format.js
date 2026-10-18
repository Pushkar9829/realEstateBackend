// Server-written text (notifications, emails, timelines) uses the same formats
// as the web app (frontend/src/shared/lib/format.js): dd/mm/yyyy in IST, a
// 12-hour time, and Indian digit grouping for rupees.
const TZ = 'Asia/Kolkata';
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });

const valid = (v) => { if (v === null || v === undefined || v === '') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

// 24/10/2026
const istDate = (v) => { const d = valid(v); return d ? dateFmt.format(d) : ''; };
// 4:30 pm
const istTime = (v) => { const d = valid(v); return d ? timeFmt.format(d).replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`) : ''; };
// 24/10/2026, 4:30 pm
const istDateTime = (v) => { const d = valid(v); return d ? `${istDate(d)}, ${istTime(d)}` : ''; };

// Rupee amount without the symbol (templates add "₹"): 3,31,934 or 3,31,934.50.
function rupeeNumber(rupees) {
  const n = Number(rupees) || 0;
  const whole = Math.abs(n % 1) < 0.005;
  return n.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
}
const rupeeText = (rupees) => `₹${rupeeNumber(rupees)}`;
const paiseNumber = (paise) => rupeeNumber(Math.round(Number(paise) || 0) / 100);

module.exports = { istDate, istTime, istDateTime, rupeeNumber, rupeeText, paiseNumber };
