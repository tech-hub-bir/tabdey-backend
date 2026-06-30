const {
  makeToken,
  readToken,
  isAllowedTargetUrl,
} = require("../models/urlCipherModel");

const isValidHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// POST /api/url-cipher
// body: { raw_url, expires_in_minutes? }
exports.createEncryptedUrlController = async (req, res) => {
  try {
    const rawUrl = String(req.body?.raw_url ?? "").trim();
    const expiresInMinutes = Number(req.body?.expires_in_minutes ?? 0);

    if (!rawUrl) {
      return res
        .status(400)
        .json({ success: false, message: "raw_url is required" });
    }
    if (!isValidHttpUrl(rawUrl)) {
      return res.status(400).json({
        success: false,
        message: "raw_url must be a valid http/https URL",
      });
    }
    if (!isAllowedTargetUrl(rawUrl)) {
      return res
        .status(403)
        .json({ success: false, message: "Target host not allowed" });
    }
    if (
      Number.isNaN(expiresInMinutes) ||
      expiresInMinutes < 0 ||
      expiresInMinutes > 10080
    ) {
      return res.status(400).json({
        success: false,
        message: "expires_in_minutes must be between 0 and 10080",
      });
    }

    const { token, expiresAt } = makeToken(rawUrl, { expiresInMinutes });

    // shareable short link (no raw URL inside)
    // controllers/urlCipherController.js (inside createEncryptedUrlController)
    const base =
      (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "") ||
      `${req.protocol}://${req.get("host")}`;

    const prefix = (process.env.PUBLIC_PATH_PREFIX || "").replace(/\/+$/, "");

    const encrypted_url = `${base}${prefix}/url-cipher/${encodeURIComponent(token)}`;

    return res.json({
      success: true,
      encrypted_url,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error("createEncryptedUrlController error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

// GET /api/url-cipher/:token
// ✅ proxies the raw url output so the user sees the same response
exports.openEncryptedUrlController = async (req, res) => {
  try {
    const token = String(req.params.token ?? "").trim();
    if (!token) return res.status(400).send("Missing token");

    const { rawUrl, expired } = readToken(token);
    if (expired) return res.status(410).send("Link expired");

    if (!rawUrl || !isValidHttpUrl(rawUrl))
      return res.status(400).send("Invalid token");
    if (!isAllowedTargetUrl(rawUrl))
      return res.status(403).send("Target host not allowed");

    const upstream = await fetch(rawUrl, { method: "GET", redirect: "follow" });

    // Forward content type so browser renders properly
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);

    // (optional) caching headers
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) res.setHeader("cache-control", cacheControl);

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buf);
  } catch (err) {
    console.error("openEncryptedUrlController error:", err);
    return res.status(400).send("Invalid or tampered token");
  }
};
