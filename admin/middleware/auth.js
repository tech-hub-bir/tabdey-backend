// middleware/auth.js
const jwt = require("jsonwebtoken");

// Load from environment
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;

if (!ACCESS_TOKEN_SECRET) {
  console.warn(
    "[auth middleware] WARNING: ACCESS_TOKEN_SECRET is not set in environment variables."
  );
}

function auth(req, res, next) {
  try {
    const authHeader =
      req.headers["authorization"] || req.headers["Authorization"];

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: "Authorization header missing.",
      });
    }

    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({
        success: false,
        error: "Invalid Authorization header format. Use 'Bearer <token>'.",
      });
    }

    const token = parts[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Access token missing.",
      });
    }

    if (!ACCESS_TOKEN_SECRET) {
      return res.status(500).json({
        success: false,
        error: "Server auth configuration error.",
      });
    }

    jwt.verify(token, ACCESS_TOKEN_SECRET, (err, decoded) => {
      if (err) {
        console.log(token);
        console.error("[auth] JWT verify error:", err.message || err);
        return res.status(401).json({
          success: false,
          error: "Invalid or expired access token.",
        });
      }

      // decoded might contain: { user_id, role, user_name, ... }
      req.user = decoded;
      next();
    });
  } catch (err) {
    console.error("[auth] Unexpected error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal authentication error.",
    });
  }
}

module.exports = auth;
