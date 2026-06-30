// middleware/requestId.js
const crypto = require("crypto");

function requestId(req, res, next) {
  const incoming = String(req.headers["x-request-id"] || "").trim();

  req.request_id =
    incoming ||
    `REQ${Date.now()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

  res.setHeader("x-request-id", req.request_id);

  next();
}

module.exports = requestId;