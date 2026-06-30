// server.js - Orders Service with Prisma + Logger

const dotenv = require("dotenv");
dotenv.config(); // MUST be first

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

// Import Prisma
const { prisma } = require("./lib/prisma");

const { initOrderManagementTable } = require("./models/initModel");
const { startDeliveredMigrationJob } = require("./jobs/deliveredMigrationJob");
const { startPickedupMigrationJob } = require("./jobs/pickedupMigrationJob");

const orderRoutes = require("./routes/orderRoutes");
const { attachRealtime } = require("./realtime");

const notificationRoutes = require("./routes/notificationRoutes");
const usernotificationRoutes = require("./routes/userNotificationRoutes");
const scheduledOrdersRoutes = require("./routes/scheduledOrdersRoutes");
const cancelledOrderRoutes = require("./routes/cancelledOrderRoutes");
const deliveredOrderRoutes = require("./routes/deliveredOrderRoutes");

const {
  startScheduledOrderProcessor,
} = require("./services/scheduledOrderProcessor");

const {
  startPendingOrderAutoCanceller,
} = require("./services/autoCancelPendingOrders");

const {
  cleanupScheduledOrders,
} = require("./services/scheduledOrderCleanupService");

const app = express();
const PORT = Number(process.env.PORT || 1001);

app.set("trust proxy", 1);

// ───────────────────────── Database ─────────────────────────

async function testPrismaConnection() {
  try {
    await prisma.$connect();

    console.log("✅ Prisma connected to database successfully!");

    await prisma.$queryRaw`SELECT 1 as connected`;

    console.log("✅ Database connection verified");

    logger.info("Order service database connected", {
      module: "order_service",
    });
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);

    logger.error("Order service database connection failed", {
      module: "order_service",
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

    throw error;
  }
}

// ───────────────────────── Middlewares ─────────────────────────

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  })
);

// Access logger
// Keep before express.json() so malformed JSON also gets requestId/logged.
app.use(requestLogger);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Optional development console logger
if (process.env.NODE_ENV !== "production") {
  app.use((req, _res, next) => {
    console.log("➡️ HIT", req.method, req.originalUrl);
    next();
  });
}

// ───────────────────────── Uploads Static ─────────────────────────

const UPLOAD_ROOT =
  process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

app.use("/uploads", express.static(UPLOAD_ROOT));

console.log("✅ Orders UPLOAD_ROOT:", UPLOAD_ROOT);

logger.info("Orders upload root configured", {
  module: "order_service",
  uploadRoot: UPLOAD_ROOT,
});

// ───────────────────────── Optional Static Test Pages ─────────────────────────

app.use(express.static(path.join(__dirname, "public")));

// ───────────────────────── Health ─────────────────────────

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "order-service",
    timestamp: new Date().toISOString(),
  });
});

// ───────────────────────── Root Endpoint ─────────────────────────

app.get("/", (_req, res) => {
  return res.json({
    message: "📦 Order Service is running",
    status: "healthy",
    endpoints: {
      health: "GET /health",
      orders: "/api/orders",
      cancelled: "/cancelled",
      delivered: "/api/delivered-orders",
      scheduled: "/api/scheduled-orders",
      notifications: "/api/order_notification",
      user_notifications: "/api/user_notification",
    },
  });
});

// ───────────────────────── REST Routes ─────────────────────────

app.use("/", orderRoutes);
app.use("/api/order_notification", notificationRoutes);
app.use("/api/user_notification", usernotificationRoutes);
app.use("/api", scheduledOrdersRoutes);
app.use("/cancelled", cancelledOrderRoutes);
app.use("/api/delivered-orders", deliveredOrderRoutes);

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

// Must always be after all routes and 404 handler
app.use(errorHandler);

// ───────────────────────── HTTP Server + Socket.IO ─────────────────────────

const server = http.createServer(app);

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

// ───────────────────────── Startup ─────────────────────────

(async () => {
  try {
    await testPrismaConnection();

    await initOrderManagementTable();

    logger.info("Order management tables initialized", {
      module: "order_service",
    });

    await attachRealtime(server);

    logger.info("Realtime socket attached", {
      module: "order_service",
    });

    // Background services

    startScheduledOrderProcessor();

    logger.info("Scheduled order processor started", {
      module: "order_service",
    });

    startPendingOrderAutoCanceller();

    logger.info("Pending order auto-canceller started", {
      module: "order_service",
    });

    startDeliveredMigrationJob({
      intervalMs: 60_000,
      batchSize: 50,
    });

    logger.info("Delivered migration job started", {
      module: "order_service",
      intervalMs: 60_000,
      batchSize: 50,
    });

    startPickedupMigrationJob({
      intervalMs: 60_000,
      batchSize: 50,
    });

    logger.info("Picked-up migration job started", {
      module: "order_service",
      intervalMs: 60_000,
      batchSize: 50,
    });

    await cleanupScheduledOrders();

    logger.info("Initial scheduled orders cleanup completed", {
      module: "order_service",
    });

    setInterval(() => {
      cleanupScheduledOrders().catch((error) => {
        console.error("❌ Scheduled orders cleanup interval error:", error);

        logger.error("Scheduled orders cleanup interval error", {
          module: "order_service",
          message: error.message,
          stack: error.stack,
        });
      });
    }, 60_000);

    console.log(
      "🧹 Scheduled orders cleanup started: pending + rejected + legacy (1 min interval)"
    );

    logger.info("Scheduled orders cleanup interval started", {
      module: "order_service",
      intervalMs: 60_000,
    });

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `\n🚀 Order service + Realtime listening on port number: ${PORT}`
      );
      console.log(`📍 URL: http://localhost:${PORT}`);
      console.log(`❤️  Health check: http://localhost:${PORT}/health`);
      console.log(`📦 Uploads served at: http://localhost:${PORT}/uploads/...`);
      console.log(`⏰ Started at: ${new Date().toISOString()}\n`);

      logger.info("Order service started", {
        module: "order_service",
        port: PORT,
      });
    });

    if (process.env.NODE_ENV !== "production") {
      setTimeout(listRoutes, 100);
    }
  } catch (error) {
    console.error("Boot failed:", error);

    logger.error("Order service boot failed", {
      module: "startup",
      message: error.message,
      stack: error.stack,
    });

    process.exit(1);
  }
})();

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received, shutting down gracefully...");

  logger.warn("SIGINT received, shutting down order service", {
    module: "shutdown",
  });

  await prisma.$disconnect();

  console.log("✅ Prisma disconnected");

  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down gracefully...");

  logger.warn("SIGTERM received, shutting down order service", {
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