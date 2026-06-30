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
const foodMenuRoute = require("./routes/foodMenuRoute");
const foodDiscoveryRoute = require("./routes/foodDiscoveryRoute");
const foodMenuBrowseRoute = require("./routes/foodMenuBrowseRoute");
const foodRatingsRoutes = require("./routes/foodRatingsRoutes");

const app = express();
const PORT = process.env.PORT || 3003;

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

console.log("📂 Serving food uploads from:", UPLOAD_ROOT);

app.use("/uploads", express.static(UPLOAD_ROOT));

// ───────────────────────── Database ─────────────────────────

async function testPrismaConnection() {
  try {
    await prisma.$connect();

    console.log("✅ Prisma connected to database successfully!");

    await prisma.$queryRaw`SELECT 1 as connected`;

    console.log("✅ Database connection verified");

    logger.info("Food service database connected", {
      module: "food_service",
    });
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);

    logger.error("Food service database connection failed", {
      module: "food_service",
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
    service: "food-service",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "food-service",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    message: "🍔 Food service is running",
    status: "healthy",
    endpoints: {
      health: "GET /health",
      menu: "/api/food-menu",
      discovery: "/api/food/discovery",
      browse: "/api/food",
      ratings: "/api/food/ratings",
      cart: "/api/food/cart",
    },
  });
});

// Food routes
app.use("/api/food-menu", foodMenuRoute);
app.use("/api/food/discovery", foodDiscoveryRoute);
app.use("/api/food", foodMenuBrowseRoute);
app.use("/api/food/ratings", foodRatingsRoutes);

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
    console.log(`\n🚀 Food service running on port ${PORT}`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
    console.log(`⏰ Started at: ${new Date().toISOString()}\n`);

    logger.info("Food service started", {
      module: "food_service",
      port: PORT,
    });
  });
}

startServer();

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received, shutting down gracefully...");

  logger.warn("SIGINT received, shutting down food service", {
    module: "shutdown",
  });

  await prisma.$disconnect();

  console.log("✅ Prisma disconnected");

  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down gracefully...");

  logger.warn("SIGTERM received, shutting down food service", {
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