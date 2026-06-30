// src/server.js
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import cors from "cors"; // ✅ ADDED
import { config } from "./config.js";
import { SmppManager } from "./smpp/SmppManager.js";
import { smsRouter } from "./routes/sms.routes.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();

/* =======================================================
   CORS CONFIGURATION
======================================================= */
const corsOptions = {
  origin: "*", // 🔥 change to your frontend domain in production
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"], // ✅ FIX
};

// Apply CORS globally
app.use(cors(corsOptions));

/* =======================================================
   MIDDLEWARES
======================================================= */
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));

/**
 * SMPP manager
 */
const smpp = new SmppManager({
  logger,
  providers: config.smpp.providers,
  defaultProvider: config.smpp.defaultProvider,
});

/**
 * Startup logs
 */
logger.info(
  {
    port: config.port,
    env: process.env.NODE_ENV || "production",
    smpp: {
      defaultProvider: config.smpp.defaultProvider,
      providers: Object.keys(config.smpp.providers || {}),
    },
  },
  "SMS Gateway starting",
);

smpp.start();

/**
 * Health endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    smpp: {
      defaultProvider: smpp.getDefaultProvider(),
      providers: smpp.isReady(),
    },
    time: new Date().toISOString(),
  });
});

/**
 * SMS API
 */
app.use("/api/sms", smsRouter({ smpp, logger }));

/**
 * Start server
 */
const server = app.listen(config.port, () => {
  logger.info(`SMS Gateway listening on http://localhost:${config.port}`);
});

/**
 * Graceful shutdown
 */
async function shutdown(signal) {
  try {
    logger.info({ signal }, "Shutting down...");

    server.close(() => {
      logger.info("HTTP server closed");
    });

    try {
      await Promise.resolve(smpp.stop());
      logger.info("SMPP stopped");
    } catch (e) {
      logger.error({ err: e }, "Error stopping SMPP");
    }

    setTimeout(() => process.exit(0), 300);
  } catch (e) {
    logger.error({ err: e }, "Shutdown error");
    process.exit(1);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * Error handling
 */
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  process.exit(1);
});
