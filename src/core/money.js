// All money is stored as integer paise to avoid floating point drift.
// Convert at the API edge only: rupees in requests/settings, paise in the DB.
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => Math.round(Number(paise)) / 100;

// Percentage of an amount in paise, rounded half-up to the nearest paisa.
const percentOf = (paise, percent) => Math.round((paise * Number(percent)) / 100);

// Split `total` across weights so the parts always add back up to `total`
// (used for pro-rating order-level discounts across lines).
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % parts.length, rest -= 1) parts[i] += 1;
  return parts;
}

module.exports = { toPaise, toRupees, percentOf, allocate };
