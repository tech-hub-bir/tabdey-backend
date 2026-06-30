// server.js - CORRECT ORDER
const dotenv = require("dotenv");
dotenv.config(); // MUST be first

const express = require("express");
const path = require("path");
const cors = require("cors");

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

const { prisma } = require("./lib/prisma.js");
// const connectMongo = require("./config/mongo");
const { checkAndCreateTables } = require("./models/initModel");

const registrationRoutes = require("./routes/registrationRoute");
const authRoutes = require("./routes/authRoute");
const deviceRoutes = require("./routes/deviceRoute");
const forgotPasswordRoute = require("./routes/forgotPasswordRoute");
const profileRoutes = require("./routes/profileRoute");
const smsOtpRoutes = require("./routes/smsOtpRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

// ───────────────────────── Middlewares ─────────────────────────

app.use(cors());

// Access logger
// Keep this before express.json() so even malformed JSON errors get requestId/logged.
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

console.log("📂 Serving uploads from:", UPLOAD_ROOT);

app.use("/uploads", express.static(UPLOAD_ROOT));

// ───────────────────────── Database Setup ─────────────────────────

async function initializeDatabase() {
  try {
    // connectMongo();

    checkAndCreateTables();

    await prisma.$connect();

    console.log("✅ Prisma connected to database successfully!");

    logger.info("Prisma connected to database successfully", {
      module: "startup",
    });
  } catch (error) {
    console.error("❌ Database initialization failed:", error);

    logger.error("Database initialization failed", {
      module: "startup",
      message: error.message,
      stack: error.stack,
    });

    throw error;
  }
}

// ───────────────────────── Routes ─────────────────────────

app.get("/", (_req, res) => {
  res.send("🚗 Ride App Backend Running");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRoutes);
app.use("/api/sms-otp", smsOtpRoutes);
app.use("/api", registrationRoutes);
app.use("/api", deviceRoutes);
app.use("/api/forgotpassword", forgotPasswordRoute);
app.use("/api/profile", profileRoutes);

// Temporary test route for checking error logs.
// Remove after testing.
// app.get("/api/test-error", (_req, _res, next) => {
//   next(new Error("This is a test error log"));
// });

// ───────────────────────── Route List Debug ─────────────────────────

const listRoutes = () => {
  const stack = app?._router?.stack || [];

  console.log("---- ROUTES ----");

  for (const layer of stack) {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase())
        .join(",");

      console.log(`${methods} ${layer.route.path}`);
    }
  }

  console.log("---------------");
};

if (process.env.NODE_ENV !== "production") {
  listRoutes();
}

// ───────────────────────── 404 Handler ─────────────────────────

app.use("/api", (req, res) => {
  logger.error("API route not found", {
    requestId: req.requestId,
    module: req.moduleName || "general",
    method: req.method,
    url: req.originalUrl,
    statusCode: 404,
    ip: req.ip,
    userAgent: req.get("user-agent") || null,
    userId: req.user?.user_id || req.user?.id || null,
  });

  res.status(404).json({
    success: false,
    error: "Not found",
    requestId: req.requestId,
  });
});

// ───────────────────────── Global Express Error Handler ─────────────────────────

// Must always be after all routes and after the 404 handler
app.use(errorHandler);

// ───────────────────────── Startup ─────────────────────────

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running at port ${PORT}`);

      logger.info("Server started", {
        module: "startup",
        port: PORT,
      });
    });
  } catch (error) {
    logger.error("Server startup failed", {
      module: "startup",
      message: error.message,
      stack: error.stack,
    });

    process.exit(1);
  }
}

startServer();

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing Prisma connection...");

  logger.warn("SIGINT received, closing server", {
    module: "shutdown",
  });

  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing Prisma connection...");

  logger.warn("SIGTERM received, closing server", {
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

process.on("uncaughtException", async (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);

  logger.error("UNCAUGHT EXCEPTION", {
    module: "process",
    message: error.message,
    stack: error.stack,
  });

  await prisma.$disconnect();
  process.exit(1);
});

module.exports = app;