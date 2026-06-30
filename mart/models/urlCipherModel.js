const crypto = require("crypto");

/**
 * ENV:
 *  LINK_ENC_KEY=super_long_secret
 *  URL_CIPHER_ALLOWED_HOSTS=grab.newedge.bt,api.grab.newedge.bt
 */

const SECRET = process.env.LINK_ENC_KEY || "CHANGE_ME_IN_ENV";
const KEY = crypto.createHash("sha256").update(SECRET).digest(); // 32 bytes

const ALLOWED_HOSTS = String(
  process.env.URL_CIPHER_ALLOWED_HOSTS || "grab.newedge.bt",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedTargetUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return ALLOWED_HOSTS.includes(u.hostname) || ALLOWED_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

function encryptPayload(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);

  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

function decryptPayload(token) {
  const b = Buffer.from(token, "base64url");
  if (b.length < 12 + 16 + 1) throw new Error("Invalid token");

  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const ciphertext = b.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function makeToken(rawUrl, { expiresInMinutes = 0 } = {}) {
  const now = Date.now();
  const expiresAt =
    expiresInMinutes > 0
      ? new Date(now + expiresInMinutes * 60 * 1000).toISOString()
      : null;

  const payload = {
    u: rawUrl,
    iat: now,
    exp: expiresAt ? Date.parse(expiresAt) : null,
  };

  return { token: encryptPayload(payload), expiresAt };
}

function readToken(token) {
  const payload = decryptPayload(token);
  const rawUrl = String(payload?.u ?? "");
  const exp = payload?.exp ? Number(payload.exp) : null;
  const expired = exp ? Date.now() > exp : false;
  return { rawUrl, expired };
}

module.exports = {
  makeToken,
  readToken,
  isAllowedTargetUrl,
};
