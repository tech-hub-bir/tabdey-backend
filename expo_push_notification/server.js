// server.js - CORRECT ORDER
const dotenv = require("dotenv");
dotenv.config(); // MUST be first

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

const express = require("express");
const cors = require("cors");

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

const { prisma } = require("./lib/prisma.js");
const pushRoutes = require("./routes/pushRoutes");

const app = express();
const PORT = Number(process.env.PORT || 3007);
const HOST = process.env.HOST || "0.0.0.0";

app.set("trust proxy", 1);

// ───────────────────────── Middlewares ─────────────────────────

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Access logger
// Keep before express.json() so malformed JSON also gets requestId/logged.
app.use(requestLogger);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Optional development console logger
if (process.env.NODE_ENV !== "production") {
  app.use((req, _res, next) => {
    console.log("➡️ HIT", req.method, req.originalUrl);
    next();
  });
}

// ───────────────────────── Database ─────────────────────────

async function testPrismaConnection() {
  try {
    await prisma.$connect();

    console.log("✅ Prisma connected to database successfully!");

    await prisma.$queryRaw`SELECT 1 as connected`;

    console.log("✅ Database connection verified");

    logger.info("Prisma connected to database successfully", {
      module: "push_notifications",
    });
  } catch (error) {
    console.error("❌ Prisma connection failed:", error.message);

    logger.error("Prisma connection failed", {
      module: "push_notifications",
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
    service: "expo-push-notification",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    message: "📱 Expo Push Notification Service",
    status: "running",
    endpoints: {
      health: "GET /health",
      sendPush: "POST /api/push/send",
      registerToken: "POST /api/push/register-token",
      getTokens: "GET /api/push/tokens/:user_id",
    },
  });
});

app.use("/api/push", pushRoutes);

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

  app.listen(PORT, HOST, () => {
    console.log(`\n🚀 Expo Push Notification Service is running!`);
    console.log(
      `📍 URL: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`
    );
    console.log(`❤️  Health check : http://localhost:${PORT}/health`);
    console.log(`📱 Push API base: http://localhost:${PORT}/api/push`);
    console.log(`⏰ Started at: ${new Date().toISOString()}\n`);

    logger.info("Push notification service started", {
      module: "push_notifications",
      port: PORT,
      host: HOST,
    });
  });
}

startServer();

// ───────────────────────── Graceful Shutdown ─────────────────────────

process.on("SIGINT", async () => {
  console.log("\n🛑 SIGINT received, shutting down gracefully...");

  logger.warn("SIGINT received, shutting down push notification service", {
    module: "shutdown",
  });

  await prisma.$disconnect();

  console.log("✅ Prisma disconnected");

  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 SIGTERM received, shutting down gracefully...");

  logger.warn("SIGTERM received, shutting down push notification service", {
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