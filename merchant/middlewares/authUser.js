// middlewares/authUser.js
const jwt = require("jsonwebtoken");

/**
 * Auth middleware for user-side APIs.
 * Requires:
 *   - Authorization: Bearer <access_token>
 *   - ACCESS_TOKEN_SECRET in env
 * Populates req.user = { user_id, role, phone, ... }
 */
function authUser(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    console.log("[Auth] Authorization header present:", !!hdr);
    
    if (!hdr.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Missing or invalid Authorization header",
      });
    }

    const token = hdr.slice(7).trim();
    console.log("[Auth] Token length:", token.length);
    console.log("[Auth] Token first 20 chars:", token.substring(0, 20));

    const secret = process.env.ACCESS_TOKEN_SECRET;
    console.log("[Auth] Secret loaded:", !!secret);
    console.log("[Auth] Secret length:", secret?.length);
    
    if (!secret) {
      console.error("[authUser] ACCESS_TOKEN_SECRET is not set");
      return res
        .status(500)
        .json({ success: false, message: "Auth not configured" });
    }

    // Decode without verification to see payload
    const decodedWithoutVerify = jwt.decode(token);
    console.log("[Auth] Decoded payload (unverified):", decodedWithoutVerify);
    console.log("[Auth] Token exp:", decodedWithoutVerify?.exp);
    console.log("[Auth] Current time:", Math.floor(Date.now() / 1000));
    
    if (decodedWithoutVerify?.exp && decodedWithoutVerify.exp < Math.floor(Date.now() / 1000)) {
      console.log("[Auth] TOKEN IS EXPIRED!");
    }

    const decoded = jwt.verify(token, secret);
    console.log("[Auth] Verification successful!");
    
    const user_id = decoded.user_id ?? decoded.uid ?? decoded.id ?? decoded.sub;

    if (!user_id) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid token payload" });
    }

    req.user = {
      ...decoded,
      user_id,
    };
    return next();
  } catch (e) {
    console.error("[authUser] error details:", {
      name: e.name,
      message: e.message,
      expiredAt: e.expiredAt,
      stack: e.stack
    });
    return res
      .status(401)
      .json({ success: false, message: e.name === "TokenExpiredError" ? "Token expired" : "Invalid token" });
  }
}

module.exports = authUser;
