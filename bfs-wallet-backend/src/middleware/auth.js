// src/middleware/auth.js
const jwt = require("jsonwebtoken");

function extractBearer(req) {
  const h = req.headers.authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function pickSecret() {
  return (
    process.env.JWT_ACCESS_SECRET ||
    process.env.ACCESS_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    ""
  );
}

function requireUserAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const secret = pickSecret();
    if (!secret) {
      return res.status(500).json({ ok: false, error: "JWT_SECRET is not set" });
    }

    const payload = jwt.verify(token, secret);

    // ✅ Map payload -> req.user (support both user_id and id)
    const userId = payload.user_id ?? payload.id ?? payload.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    req.user = {
      id: Number(userId),
      role: payload.role || "user",
      phone: payload.phone || null,
      raw: payload, // optional for debugging
    };

    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

function requireAdminAuth(req, res, next) {
  requireUserAuth(req, res, () => {
    const role = String(req.user.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    next();
  });
}

module.exports = { requireUserAuth, requireAdminAuth };
