// src/utils/nvp.js
function toFormUrlEncoded(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      usp.append(key, String(value));
    }
  }
  return usp.toString();
}

function parseBfsResponse(raw) {
  if (!raw) return {};

  let str = raw.trim();

  // 1) Normal case: NVP a=b&c=d (what BFS actually sends)
  if (str.includes("&") && str.includes("=")) {
    const usp = new URLSearchParams(str);
    const obj = {};
    for (const [k, v] of usp.entries()) {
      obj[k] = v; // URLSearchParams automatically decodes % and +
    }
    return obj;
  }

  // 2) Fallback: some sample/log formats like "a=b, c=d" or "{a=b, c=d}"
  if (str.startsWith("{") && str.endsWith("}")) {
    str = str.slice(1, -1);
  }

  const pairs = str.split(",").map((p) => p.trim());
  const obj = {};
  for (let p of pairs) {
    if (!p) continue;
    const eqIndex = p.indexOf("=");
    if (eqIndex === -1) continue;
    const key = p.slice(0, eqIndex).trim();
    const val = p.slice(eqIndex + 1).trim();
    obj[key] = val;
  }

  return obj;
}

module.exports = {
  toFormUrlEncoded,
  parseBfsResponse,
};
