// src/utils/money.js
const crypto = require("crypto");

function safeStr(v) {
  return v == null ? "" : String(v).trim();
}

// "100" "100.5" "100.50" -> "100.50"
function normalizeNuAmount(input) {
  const s = safeStr(input);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, d = ""] = s.split(".");
  const dec = (d + "00").slice(0, 2);
  const intPart = String(Number(i));
  return `${intPart}.${dec}`;
}

function genId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

// Compare two decimals as cents using BigInt
function cmpDec(a, b) {
  const toCents = (x) => {
    const n = normalizeNuAmount(x);
    if (!n) return null;
    const [i, d] = n.split(".");
    return BigInt(i) * 100n + BigInt(d);
  };
  const A = toCents(a);
  const B = toCents(b);
  if (A == null || B == null) return null;
  if (A < B) return -1;
  if (A > B) return 1;
  return 0;
}

module.exports = { safeStr, normalizeNuAmount, genId, cmpDec };
