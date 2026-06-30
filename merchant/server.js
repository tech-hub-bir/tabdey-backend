// server.js - CORRECT ORDER
const dotenv = require("dotenv");
dotenv.config(); // MUST be first

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

const express = require("express");
const path = require("path");
const cors = require("cors");

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

const { initMerchantTables } = require("./models/initModel");

const merchantRoutes = require("./routes/merchantRegistrationRoute");
const businessTypesRoutes = require("./routes/businessTypesRoute");
const categoryRoutes = require("./routes/categoryRoute");
const bannerRoutes = require("./routes/bannerRoutes");
const updateMerchantRoute = require("./routes/updateMerchantRoute");
const merchantRatings = require("./routes/merchantRatings");
const salesRoutes = require("./routes/salesRoutes");
const merchantEarningsRoutes = require("./routes/merchantEarningsRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

// ───────────────────────── Middlewares ─────────────────────────

app.use(cors());

// Access logger
// Keep before express.json() so malformed JSON also gets requestId/logged.
app.use(requestLogger);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Optional development console logger
if (process.env.NODE_ENV !== "production") {
  app.use((req, _res, next) => {
    console.log("➡️ HIT", req.method, req.originalUrl);
    next();
  });
}

// ───────────────────────── Static Uploads ─────────────────────────

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, "uploads");

console.log("📂 Serving merchant uploads from:", UPLOAD_ROOT);

app.use("/uploads", express.static(UPLOAD_ROOT));

// ───────────────────────── Database / Tables ─────────────────────────

// Uncomment if you want table initialization at startup.
// initMerchantTables()
//   .then(() => {
//     console.log("✅ Merchant tables initialized");

//     logger.info("Merchant tables initialized", {
//       module: "merchant_service",
//     });
//   })
//   .catch((error) => {
//     console.error("❌ Error initializing merchant tables:", error);

//     logger.error("Error initializing merchant tables", {
//       module: "merchant_service",
//       message: error.message,
//       stack: error.stack,
//     });
//   });

// ───────────────────────── Routes ─────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "merchant-service",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/merchant", merchantRoutes);
app.use("/api/admin", businessTypesRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api", updateMerchantRoute);
app.use("/api/merchant", merchantRatings);
app.use("/api/sales", salesRoutes);
app.use("/api", merchantEarningsRoutes);

// ───────────────────────── Upload / Multer Error Handler ─────────────────────────

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    logger.error("Upload file too large", {
      requestId: req.requestId,
      module: req.moduleName || "merchant_service",
      method: req.method,
      url: req.originalUrl,
      statusCode: 413,
      message: err.message,
      code: err.code,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
    });

    return res.status(413).json({
      success: false,
      message: "File too large. Max allowed size exceeded.",
      requestId: req.requestId,
    });
  }

  if (err && err.name === "MulterError") {
    logger.error("Multer upload error", {
      requestId: req.requestId,
      module: req.moduleName || "merchant_service",
      method: req.method,
      url: req.originalUrl,
      statusCode: 400,
      message: err.message,
      code: err.code,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
    });

    return res.status(400).json({
      success: false,
      message: err.message || "Upload failed.",
      requestId: req.requestId,
    });
  }

  next(err);
});

// ───────────────────────── 404 Handler ─────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
    requestedUrl: req.originalUrl,
    requestId: req.requestId,
  });
});

// ───────────────────────── Global Express Error Handler ─────────────────────────

// Must always be after all routes, upload error handler, and 404 handler.
app.use(errorHandler);

// ───────────────────────── Startup ─────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Merchant service running at port: ${PORT}`);

  logger.info("Merchant service started", {
    module: "merchant_service",
    port: PORT,
  });
});

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGINT", () => {
  console.log("\n🛑 SIGINT received, shutting down merchant service...");

  logger.warn("SIGINT received, shutting down merchant service", {
    module: "shutdown",
  });

  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 SIGTERM received, shutting down merchant service...");

  logger.warn("SIGTERM received, shutting down merchant service", {
    module: "shutdown",
  });

  process.exit(0);
});

// ───────────────────────── Global Node.js Error Handlers ─────────────────────────

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  console.error(error.stack);

  logger.error("UNCAUGHT EXCEPTION", {
    module: "process",
    message: error.message,
    stack: error.stack,
  });

  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("reason:", reason);

  logger.error("UNHANDLED REJECTION", {
    module: "process",
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : null,
  });

  process.exit(1);
});