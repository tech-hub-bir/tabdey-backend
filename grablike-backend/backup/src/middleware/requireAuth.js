// src/middleware/requireAuth.js
// ✅ Express auth middleware that sets req.user.user_id from your JWT access token.
// - Reads "Authorization: Bearer <token>"
// - Verifies signature + exp
// - Attaches req.user = { user_id, ...claims }
// - Works with tokens that use any of these common id claim names:
//   user_id | userId | id | sub
//
// ENV REQUIRED:
//   JWT_ACCESS_SECRET=your_access_token_secret
//   (or JWT_SECRET / ACCESS_TOKEN_SECRET as fallback)

import jwt from "jsonwebtoken";

function pickSecret() {
  return (
    process.env.JWT_ACCESS_SECRET ||
    process.env.ACCESS_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    ""
  );
}

function extractBearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const s = String(h).trim();
  if (!s) return null;
  const m = s.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function requireAuth(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "missing_token" });
    }

    const secret = pickSecret();
    if (!secret) {
      // server misconfig
      return res.status(500).json({ ok: false, error: "jwt_secret_not_set" });
    }

    // verify + decode
    let decoded;
    try {
      decoded = jwt.verify(token, secret);
    } catch (e) {
      const msg = String(e?.name || "");
      if (msg === "TokenExpiredError") {
        return res.status(401).json({ ok: false, error: "token_expired" });
      }
      return res.status(401).json({ ok: false, error: "invalid_token" });
    }

    // normalize user id from common claim names
    const uid =
      asInt(decoded?.user_id) ??
      asInt(decoded?.userId) ??
      asInt(decoded?.id) ??
      asInt(decoded?.sub);

    if (!uid) {
      return res
        .status(401)
        .json({ ok: false, error: "invalid_token_payload" });
    }

    // attach to req for controllers
    req.user = {
      user_id: uid,
      ...decoded,
    };

    return next();
  } catch (e) {
    console.error("[requireAuth] error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

export default requireAuth;
