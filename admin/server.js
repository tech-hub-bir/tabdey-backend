// server.js
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

const { prisma } = require("./lib/prisma.js");
const { UPLOAD_ROOT } = require("./middleware/upload");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1); // if behind proxy: nginx / k8s / render / railway

// ───────────────────────── Middlewares ─────────────────────────

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Access logger - logs every request automatically
app.use(requestLogger);

// Optional development console logger
if (process.env.NODE_ENV !== "production") {
  app.use((req, _res, next) => {
    console.log("➡️ HIT", req.method, req.originalUrl);
    next();
  });
}

// ───────────────────────── Static Uploads ─────────────────────────

console.log("📂 Serving admin uploads from:", UPLOAD_ROOT);

app.use("/uploads", express.static(UPLOAD_ROOT));

// ───────────────────────── Routes ─────────────────────────

const adminRoutes = require("./routes/adminRoute");
const adminLogRoutes = require("./routes/adminLogsRoute");
const orderReportRoutes = require("./routes/ordersReportRoutes");
const adminCollaboratorRoutes = require("./routes/adminCollaboratorRoutes");
const systemNotificationRoute = require("./routes/systemNotificationRoute");
const appRatingRoutes = require("./routes/appRatingRoutes");
const pointSystemRoutes = require("./routes/pointSystemRoutes");
const userPointConversionRoutes = require("./routes/userPointConversionRoutes");
const contactRoutes = require("./routes/contactMessageRoutes");
const logoImageRoutes = require("./routes/logoImageRoutes");
const accountDeletionRoutes = require("./routes/accountDeletionRoutes");

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Routes
app.use("/api/admin-logs", adminLogRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/orders", orderReportRoutes);
app.use("/api/system-notifications", systemNotificationRoute);
app.use("/api/app-ratings", appRatingRoutes);
app.use("/api/admin-collaborators", adminCollaboratorRoutes);
app.use("/api/points", pointSystemRoutes);
app.use("/api/user", userPointConversionRoutes);
app.use("/api/contact-messages", contactRoutes);
app.use("/api/logo-images", logoImageRoutes);
app.use("/api/user", accountDeletionRoutes);
app.use("/api/admin", accountDeletionRoutes);

// ───────────────────────── 404 Handler ─────────────────────────

app.use("/api", (req, res) => {
  logger.warn("API route not found", {
    requestId: req.requestId,
    module: req.moduleName || "general",
    method: req.method,
    url: req.originalUrl,
    statusCode: 404,
    ip: req.ip,
    userAgent: req.get("user-agent") || null,
  });

  res.status(404).json({
    success: false,
    error: "Not found",
    requestId: req.requestId,
  });
});

// ───────────────────────── Global Error Handler ─────────────────────────

// Must be after all routes and after 404 handler
app.use(errorHandler);

// ───────────────────────── Startup ─────────────────────────

async function start() {
  try {
    await prisma.$connect();

    console.log("✅ Prisma connected to database");

    logger.info("Prisma connected to database", {
      module: "startup",
    });

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at port number ${PORT}`);

      logger.info("Server started", {
        module: "startup",
        port: PORT,
      });
    });
  } catch (err) {
    console.error("❌ Database connection failed:", err);

    logger.error("Database connection failed", {
      module: "startup",
      message: err.message,
      stack: err.stack,
    });

    process.exit(1);
  }
}

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing server...");

  logger.warn("SIGTERM received, closing server", {
    module: "shutdown",
  });

  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing server...");

  logger.warn("SIGINT received, closing server", {
    module: "shutdown",
  });

  await prisma.$disconnect();
  process.exit(0);
});

// ───────────────────────── Global Node.js Error Handlers ─────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);

  logger.error("UNHANDLED REJECTION", {
    module: "process",
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : null,
  });
});

process.on("uncaughtException", async (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);

  logger.error("UNCAUGHT EXCEPTION", {
    module: "process",
    message: err.message,
    stack: err.stack,
  });

  await prisma.$disconnect();
  process.exit(1);
});

start();

module.exports = app;