const logger = require("../lib/logger");

const sanitizeObject = (obj = {}) => {
  if (!obj || typeof obj !== "object") return obj;

  const sensitiveFields = [
    "password",
    "confirmPassword",
    "oldPassword",
    "newPassword",
    "otp",
    "pin",
    "token",
    "accessToken",
    "refreshToken",
    "authorization",
    "Authorization",
  ];

  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

  for (const key of Object.keys(sanitized)) {
    if (sensitiveFields.includes(key)) {
      sanitized[key] = "***HIDDEN***";
    } else if (
      sanitized[key] &&
      typeof sanitized[key] === "object" &&
      !(sanitized[key] instanceof Buffer)
    ) {
      sanitized[key] = sanitizeObject(sanitized[key]);
    }
  }

  return sanitized;
};

const errorHandler = (err, req, res, _next) => {
  const statusCode = err.statusCode || err.status || 500;

  logger.error("Unhandled API error", {
    requestId: req.requestId,
    module: req.moduleName || "general",
    method: req.method,
    url: req.originalUrl,
    statusCode,
    message: err.message,
    name: err.name,
    code: err.code || null,
    stack: err.stack,
    ip: req.ip,
    userAgent: req.get("user-agent") || null,
    body: sanitizeObject(req.body),
    params: sanitizeObject(req.params),
    query: sanitizeObject(req.query),
    userId: req.user?.user_id || req.user?.id || null,
  });

  res.status(statusCode).json({
    success: false,
    error:
      process.env.NODE_ENV === "production" && statusCode === 500
        ? "Internal server error"
        : err.message || "Internal server error",
    requestId: req.requestId,
  });
};

module.exports = errorHandler;