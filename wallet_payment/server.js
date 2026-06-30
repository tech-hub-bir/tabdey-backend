// File: server.js - Wallet Payment Service with Access/Error Logging
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

const { prisma } = require("./lib/prisma");

const walletRoutes = require("./routes/walletRoutes");
const txRoutes = require("./routes/transactionHistoryRoutes");
const idRoutes = require("./routes/idRoutes");
const platformFeeRuleRoutes = require("./routes/platformFeeRuleRoutes");
const walletTransactionLogRoutes = require("./routes/walletTransactionLogRoutes");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set("trust proxy", 1);

/* ─────────────────── Middleware ─────────────────── */

app.use(helmet());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// make sure preflight always succeeds
app.options(/.*/, cors());

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

/* ─────────────────── Routes ─────────────────── */

app.use("/wallet", walletRoutes);
app.use("/transactions", txRoutes);
app.use("/ids", idRoutes);
app.use("/api/platform-fee-rules", platformFeeRuleRoutes);
app.use("/wallet-transaction-logs", walletTransactionLogRoutes);

/* ─────────────────── Health endpoints ─────────────────── */

app.get("/", (_req, res) => {
  return res.json({
    ok: true,
    service: "wallet_payment",
  });
});

app.get("/wallet/health", async (_req, res, next) => {
  try {
    await prisma.$connect();

    return res.json({
      ok: true,
      service: "wallet_payment",
      prisma: "connected",
      now: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/health", async (_req, res, next) => {
  try {
    await prisma.$connect();

    return res.json({
      ok: true,
      service: "wallet_payment",
      prisma: "connected",
      now: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

/* ─────────────────── 404 Handler ─────────────────── */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found.",
    path: req.originalUrl,
    requestId: req.requestId,
  });
});

/* ─────────────────── Global Error Handler ─────────────────── */

// Must be after all routes and after 404 handler
app.use(errorHandler);

/* ─────────────────── Prisma connection check ─────────────────── */

async function checkPrismaConnection() {
  try {
    await prisma.$connect();

    console.log("[prisma] connected successfully");

    logger.info("Wallet payment Prisma connected successfully", {
      module: "wallet_payment",
    });

    return true;
  } catch (error) {
    console.error("[prisma] connection failed", {
      message: error?.message,
      code: error?.code,
    });

    logger.error("Wallet payment Prisma connection failed", {
      module: "wallet_payment",
      message: error?.message,
      code: error?.code || null,
      stack: error?.stack || null,
    });

    return false;
  }
}

/* ─────────────────── Graceful shutdown ─────────────────── */

let server = null;

async function shutdown(signal) {
  console.log(`[server] received ${signal}. Shutting down...`);

  logger.warn("Wallet payment shutdown signal received", {
    module: "shutdown",
    signal,
  });

  try {
    if (server) {
      server.close(() => {
        console.log("[server] HTTP server closed");

        logger.info("Wallet payment HTTP server closed", {
          module: "shutdown",
        });
      });
    }
  } catch (error) {
    console.error("[server] close error", error?.message || error);

    logger.error("Wallet payment server close error", {
      module: "shutdown",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  }

  try {
    await prisma.$disconnect();

    console.log("[prisma] disconnected");

    logger.info("Wallet payment Prisma disconnected", {
      module: "shutdown",
    });
  } catch (error) {
    console.error("[prisma] disconnect error", error?.message || error);

    logger.error("Wallet payment Prisma disconnect error", {
      module: "shutdown",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* ─────────────────── Global Process Error Handlers ─────────────────── */

process.on("uncaughtException", async (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  console.error(error.stack);

  logger.error("UNCAUGHT EXCEPTION", {
    module: "process",
    message: error.message,
    stack: error.stack,
  });

  try {
    await prisma.$disconnect();
  } catch {}

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

  try {
    await prisma.$disconnect();
  } catch {}

  process.exit(1);
});

/* ─────────────────── Listen ─────────────────── */

async function startServer() {
  const prismaOk = await checkPrismaConnection();

  if (!prismaOk) {
    console.error("[server] Startup aborted because Prisma could not connect.");

    logger.error("Wallet payment startup aborted because Prisma could not connect", {
      module: "startup",
    });

    process.exit(1);
  }

  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`💰 wallet_payment listening on: ${PORT}`);

    logger.info("Wallet payment service started", {
      module: "wallet_payment",
      port: PORT,
    });
  });
}

startServer().catch((error) => {
  console.error("[server] fatal startup error", {
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
  });

  logger.error("Wallet payment fatal startup error", {
    module: "startup",
    message: error?.message,
    code: error?.code || null,
    stack: error?.stack || null,
  });

  process.exit(1);
});

module.exports = app;