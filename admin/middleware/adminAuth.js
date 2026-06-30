// middleware/adminAuth.js
const jwt = require("jsonwebtoken");

const ACCESS_TOKEN_SECRET =
  process.env.ACCESS_TOKEN_SECRET || "your_access_token_secret_here";

function getTokenFromRequest(req) {
  const authHeader =
    req.headers["authorization"] || req.headers["Authorization"];

  if (!authHeader) {
    return {
      error: {
        status: 401,
        body: {
          success: false,
          error: "Authorization header missing.",
        },
      },
    };
  }

  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return {
      error: {
        status: 401,
        body: {
          success: false,
          error: "Invalid authorization format. Use Bearer <access_token>.",
        },
      },
    };
  }

  return { token };
}

function verifyAccessToken(req) {
  const tokenResult = getTokenFromRequest(req);

  if (tokenResult.error) {
    return tokenResult;
  }

  try {
    const decoded = jwt.verify(tokenResult.token, ACCESS_TOKEN_SECRET);
    return { decoded };
  } catch (err) {
    return {
      error: {
        status: 401,
        body: {
          success: false,
          error: "Invalid or expired token.",
        },
      },
    };
  }
}

// Existing middleware for current APIs.
// This keeps finance and organizer access unchanged.
function adminOnly(req, res, next) {
  try {
    const result = verifyAccessToken(req);

    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    const decoded = result.decoded;
console.log("[ADMIN JWT DECODED]", decoded);
    if (!decoded || !decoded.role) {
      return res.status(403).json({
        success: false,
        error: "Invalid token payload.",
      });
    }

    const role = String(decoded.role).toLowerCase().trim();

    const allowedRoles = ["admin", "super admin", "finance", "organizer"];

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        error: "Access denied.",
      });
    }

    req.user = {
      ...decoded,
      role,
    };

    return next();
  } catch (err) {
    console.error("adminOnly middleware error:", err);

    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
}

// Strict middleware for logo/image APIs only.
function adminOrSuperAdminOnly(req, res, next) {
  try {
    const result = verifyAccessToken(req);

    if (result.error) {
      return res.status(result.error.status).json(result.error.body);
    }

    const decoded = result.decoded;

    if (!decoded || !decoded.role) {
      return res.status(403).json({
        success: false,
        error: "Invalid token payload.",
      });
    }

    const role = String(decoded.role).toLowerCase().trim();

    const allowedRoles = ["admin", "super admin"];

    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        error: "Access denied. Admin or super admin only.",
      });
    }

    req.user = {
      ...decoded,
      role,
    };

    return next();
  } catch (err) {
    console.error("adminOrSuperAdminOnly middleware error:", err);

    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
}

// IMPORTANT:
// This keeps old imports working:
// const adminOnly = require("../middleware/adminAuth");
//
// And also supports new named import:
// const { adminOrSuperAdminOnly } = require("../middleware/adminAuth");
module.exports = adminOnly;
module.exports.adminOnly = adminOnly;
module.exports.adminOrSuperAdminOnly = adminOrSuperAdminOnly;
