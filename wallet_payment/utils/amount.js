// utils/amount.js
function normalizeNu(amount) {
  const n = typeof amount === "string" ? parseFloat(amount) : Number(amount);
  if (!isFinite(n) || n <= 0) return null;
  // toFixed returns string "25.50" which MySQL DECIMAL stores exactly
  return n.toFixed(2);
}
module.exports = { normalizeNu };
