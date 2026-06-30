// src/utils/http.js
export function ok(res, data = null, extra = {}) {
  return res.json({ success: true, data, ...extra });
}

export function fail(res, status = 400, message = "Bad request", extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}
