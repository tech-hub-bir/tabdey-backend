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

// Import Prisma
const { prisma } = require("./lib/prisma");

// Import routes
const martMenuRoutes = require("./routes/martMenuRoutes");
const martMenuBrowseRoutes = require("./routes/martMenuBrowseRoutes");
const martDiscoveryRoutes = require("./routes/martDiscoveryRoutes");
const martRatingsRoutes = require("./routes/martRatingsRoutes");
const urlCipherRoutes = require("./routes/urlCipherRoute");

const app = express();
const PORT = process.env.PORT || 3002;

app.set("trust proxy", 1);

// ───────────────────────── Middlewares ─────────────────────────

// CORS
app.use(cors({ origin: true, credentials: true }));

// Access logger
// Keep before express.json() so malformed JSON also gets logged with requestId.
app.use(requestLogger);

// JSON parsing
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

console.log("📂 Serving mart uploads from:", UPLOAD_ROOT);

app.use("/uploads", express.static(UPLOAD_ROOT));

// ───────────────────────── Database ─────────────────────────

async function testPrismaConnection() {
  try {
    await prisma.$connect();

    console.log("✅ Prisma connected to database successfully!");

    await prisma.$queryRaw`SELECT 1 as connected`;

    console.log("✅ Database connection verified");

    logger.info("Mart service database connected", {
      module: "mart_service",
    });
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);

    logger.error("Mart service database connection failed", {
      module: "mart_service",
      message: error.message,
      stack: error.stack,
    });

    if (error.message.includes("Access denied")) {
      console.error(
        "   Please check your database username and password in .env file"
      );
    } else if (error.message.includes("Unknown database")) {
      console.error(
        "   Please check if the database name is correct in .env file"
      );
    } else if (error.message.includes("connect ETIMEDOUT")) {
      console.error("   Please check if the database host is reachable");
    } else {
      console.error("   Please check your database configuration in .env file");
    }
  }
}

// ───────────────────────── Routes ─────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "mart-service",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    message: "🛍️ Mart service is running",
    status: "healthy",
    endpoints: {
      health: "GET /health",
      menu: "/api/mart-menu",
      browse: "/api/mart/browse",
      discovery: "/api/mart/discovery",
      ratings: "/api/mart/ratings",
      cart: "/api/mart/cart",
      urlCipher: "/api/url-cipher",
    },
  });
});

// Mart APIs
app.use("/api/mart-menu", martMenuRoutes);
app.use("/api/mart/browse", martMenuBrowseRoutes);
app.use("/api/mart/discovery", martDiscoveryRoutes);
app.use("/api/mart/ratings", martRatingsRoutes);
app.use("/api/url-cipher", urlCipherRoutes);

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

// Must be after all routes and 404 handler
app.use(errorHandler);

// ───────────────────────── Route List Debug ─────────────────────────

const listRoutes = () => {
  const stack = app?._router?.stack || [];

  console.log("\n📋 Registered Routes:");
  console.log("-------------------");

  for (const layer of stack) {
    if (layer.route?.path) {
      const methods = Object.keys(layer.route.methods)
        .map((m) => m.toUpperCase())
        .join(",");

      console.log(`${methods.padEnd(8)} ${layer.route.path}`);
    }
  }

  console.log("-------------------\n");
};

if (process.env.NODE_ENV !== "production") {
  setTimeout(listRoutes, 100);
}

// ───────────────────────── Startup ─────────────────────────

async function startServer() {
  await testPrismaConnection();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Mart service running on port ${PORT}`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
    console.log(`⏰ Started at: ${new Date().toISOString()}\n`);

    logger.info("Mart service started", {
      module: "mart_service",
      port: PORT,
    });
  });
}

startServer();

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received, shutting down gracefully...");

  logger.warn("SIGINT received, shutting down mart service", {
    module: "shutdown",
  });

  await prisma.$disconnect();

  console.log("✅ Prisma disconnected");

  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down gracefully...");

  logger.warn("SIGTERM received, shutting down mart service", {
    module: "shutdown",
  });

  await prisma.$disconnect();

  console.log("✅ Prisma disconnected");

  process.exit(0);
});

// ───────────────────────── Global Node.js Error Handlers ─────────────────────────

process.on("uncaughtException", async (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  console.error(error.stack);

  logger.error("UNCAUGHT EXCEPTION", {
    module: "process",
    message: error.message,
    stack: error.stack,
  });

  await prisma.$disconnect();

  process.exit(1);
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise);
  console.error("reason:", reason);

  logger.error("UNHANDLED REJECTION", {
    module: "process",
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : null,
  });

  await prisma.$disconnect();

  process.exit(1);
});