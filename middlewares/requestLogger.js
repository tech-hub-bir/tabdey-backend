const onFinished = require("on-finished");
const { randomUUID } = require("crypto");
const logger = require("../lib/logger");

const getModuleName = (url = "") => {
  if (url.includes("/api/admin-logs")) return "admin_logs";
  if (url.includes("/api/admin")) return "admin";
  if (url.includes("/api/orders")) return "orders";
  if (url.includes("/api/system-notifications")) return "system_notifications";
  if (url.includes("/api/app-ratings")) return "app_ratings";
  if (url.includes("/api/admin-collaborators")) return "admin_collaborators";
  if (url.includes("/api/points")) return "points";
  if (url.includes("/api/contact-messages")) return "contact_messages";
  if (url.includes("/api/logo-images")) return "logo_images";
  if (url.includes("/api/user")) return "user";

  return "general";
};

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

const extractResponseMessage = (body) => {
  if (!body) return null;

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return (
        parsed.message ||
        parsed.error ||
        parsed.errors ||
        parsed.msg ||
        parsed.detail ||
        null
      );
    } catch {
      return body.length > 300 ? body.slice(0, 300) + "..." : body;
    }
  }

  if (typeof body === "object") {
    return (
      body.message ||
      body.error ||
      body.errors ||
      body.msg ||
      body.detail ||
      null
    );
  }

  return null;
};

const limitResponseBody = (body) => {
  if (!body) return null;

  let safeBody = body;

  if (typeof body === "object") {
    safeBody = sanitizeObject(body);
  }

  const bodyString =
    typeof safeBody === "string" ? safeBody : JSON.stringify(safeBody);

  if (bodyString.length > 1000) {
    return bodyString.slice(0, 1000) + "...[TRUNCATED]";
  }

  return safeBody;
};

const requestLogger = (req, res, next) => {
  const startTime = process.hrtime.bigint();

  req.requestId = req.headers["x-request-id"] || randomUUID();
  req.moduleName = getModuleName(req.originalUrl);

  res.setHeader("X-Request-Id", req.requestId);

  let responseBody = null;

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  res.send = (body) => {
    responseBody = body;
    return originalSend(body);
  };

  onFinished(res, () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;

    const baseLogData = {
      requestId: req.requestId,
      module: req.moduleName,
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
      userId: req.user?.user_id || req.user?.id || null,
      responseMessage: extractResponseMessage(responseBody),
    };

    if (res.statusCode < 400) {
      logger.info("API request completed", baseLogData);
      return;
    }

    if (res.statusCode >= 400 && res.statusCode < 500) {
      logger.error("Client API error", {
        ...baseLogData,
        errorType: "client_error",
        body: sanitizeObject(req.body),
        params: sanitizeObject(req.params),
        query: sanitizeObject(req.query),
        responseBody: limitResponseBody(responseBody),
      });
      return;
    }

    logger.error("Server API error", {
      ...baseLogData,
      errorType: "server_error",
      body: sanitizeObject(req.body),
      params: sanitizeObject(req.params),
      query: sanitizeObject(req.query),
      responseBody: limitResponseBody(responseBody),
    });
  });

  next();
};

module.exports = requestLogger;