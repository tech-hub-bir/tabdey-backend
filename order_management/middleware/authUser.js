// middleware/authUser.js
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

    if (!hdr.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Missing or invalid Authorization header",
      });
    }

    const token = hdr.slice(7).trim();
    const secret = process.env.ACCESS_TOKEN_SECRET;

    if (!secret) {
      console.error("[authUser] ACCESS_TOKEN_SECRET is not set");
      return res.status(500).json({
        success: false,
        message: "Auth not configured",
      });
    }

    const decoded = jwt.verify(token, secret);
    const user_id = decoded.user_id ?? decoded.uid ?? decoded.id ?? decoded.sub;

    if (!user_id) {
      return res.status(401).json({
        success: false,
        message: "Invalid token payload",
      });
    }

    req.user = {
      ...decoded,
      user_id: Number(user_id),
    };

    return next();
  } catch (e) {
    return res.status(401).json({
      success: false,
      message: e.name === "TokenExpiredError" ? "Token expired" : "Invalid token",
    });
  }
}

function isAdminRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return r === "admin" || r === "super_admin" || r === "super admin" || r === "finance";
}

/**
 * Restricts access to the resource owner (req.params[paramName]) or an admin role.
 * Must run after authUser.
 */
function requireSelfOrAdmin(paramName) {
  return (req, res, next) => {
    const paramUserId = Number(req.params[paramName]);
    const callerId = Number(req.user?.user_id);

    if (callerId === paramUserId || isAdminRole(req.user?.role)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: "You do not have access to this resource.",
    });
  };
}

module.exports = authUser;
module.exports.isAdminRole = isAdminRole;
module.exports.requireSelfOrAdmin = requireSelfOrAdmin;
