// server.js - Chat Service with Access/Error Logging
require("dotenv").config();

// Handle BigInt serialization globally
BigInt.prototype.toJSON = function () {
  return Number(this);
};

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

const path = require("path");
const fs = require("fs/promises");

const logger = require("../lib/logger");
const requestLogger = require("../middlewares/requestLogger");
const errorHandler = require("../middlewares/errorHandler");

const { prisma } = require("./lib/prisma");

const chatRoutes = require("./routes/chatRoutes");
const upload = require("./middlewares/upload");
const store = require("./models/chatStoreRedis");

const app = express();
const PORT = Number(process.env.PORT || 4010);

app.set("trust proxy", 1);

/* -------------------- middlewares -------------------- */

app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

// Access logger
// Keep before body parser so malformed JSON can also be logged.
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

/* -------------------- static uploads -------------------- */

// Serve uploads from BOTH paths
app.use("/uploads", express.static(upload.UPLOAD_ROOT));
app.use("/chat/uploads", express.static(upload.UPLOAD_ROOT));

logger.info("Chat upload root configured", {
  module: "chat_service",
  uploadRoot: upload.UPLOAD_ROOT,
});

/* -------------------- health -------------------- */

app.get("/health", async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return res.json({
      ok: true,
      service: "user_merchant_chat",
      prisma: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "user_merchant_chat",
  });
});

/* -------------------- routes -------------------- */

app.use("/chat", chatRoutes);

/* -------------------- 404 handler -------------------- */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
    requestedUrl: req.originalUrl,
    requestId: req.requestId,
  });
});

/* -------------------- global express error handler -------------------- */

// Must be after all routes and after 404 handler
app.use(errorHandler);

/* -------------------- server + socket -------------------- */

const server = http.createServer(app);

// Socket path under /chat
const io = new Server(server, {
  path: "/chat/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"],
});

app.set("io", io);

/* -------------------- Redis adapter -------------------- */

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.warn("[socket] REDIS_URL missing. Live chat across pods will NOT work.");

  logger.warn("REDIS_URL missing. Live chat across pods will not work.", {
    module: "chat_service",
  });
} else {
  const pubClient = new Redis(REDIS_URL);
  const subClient = pubClient.duplicate();

  pubClient.on("connect", () => {
    console.log("[redis pub] connected");

    logger.info("Redis pub client connected", {
      module: "chat_service",
    });
  });

  subClient.on("connect", () => {
    console.log("[redis sub] connected");

    logger.info("Redis sub client connected", {
      module: "chat_service",
    });
  });

  pubClient.on("error", (error) => {
    console.error("[redis pub] error", error?.message || error);

    logger.error("Redis pub client error", {
      module: "chat_service",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  });

  subClient.on("error", (error) => {
    console.error("[redis sub] error", error?.message || error);

    logger.error("Redis sub client error", {
      module: "chat_service",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  });

  io.adapter(createAdapter(pubClient, subClient));

  console.log("[socket] redis adapter enabled");

  logger.info("Socket.IO Redis adapter enabled", {
    module: "chat_service",
  });
}

/* -------------------- socket rooms -------------------- */

io.on("connection", (socket) => {
  console.log("[socket] connected", socket.id);

  socket.on("chat:join", ({ conversationId }) => {
    if (!conversationId) return;

    const room = `chat:conv:${conversationId}`;

    socket.join(room);

    console.log("[socket] join", room, "socket=", socket.id);
  });

  socket.on("chat:leave", ({ conversationId }) => {
    if (!conversationId) return;

    const room = `chat:conv:${conversationId}`;

    socket.leave(room);

    console.log("[socket] leave", room, "socket=", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("[socket] disconnected", socket.id);
  });
});

/* =========================================================
   AUTO CLEANUP LOOP
   - polls delivered_orders using Prisma
   - deletes chat in Redis
   - deletes uploaded chat images
   - uses Redis lock so only ONE pod runs cleanup per interval
========================================================= */

function logCleanup(...args) {
  console.log(`[${new Date().toISOString()}] [cleanup]`, ...args);

  logger.info("Chat cleanup log", {
    module: "chat_cleanup",
    data: args,
  });
}

function logCleanupError(message, error, extra = {}) {
  console.error(`[${new Date().toISOString()}] [cleanup] ERROR`, {
    message,
    error: error?.message || error,
    ...extra,
  });

  logger.error(message, {
    module: "chat_cleanup",
    message: error?.message || String(error),
    code: error?.code || null,
    stack: error?.stack || null,
    ...extra,
  });
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// mediaUrl examples:
// - /uploads/chat/xxx.jpg
// - /chat/uploads/chat/xxx.jpg
// - https://grab.newedge.bt/chat/uploads/chat/xxx.jpg
function mediaUrlToDiskPath(mediaUrl) {
  if (!mediaUrl) return null;

  let s = String(mediaUrl).trim();

  if (!s) return null;

  // strip scheme/host if present
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      s = new URL(s).pathname;
    }
  } catch {}

  // normalize to /uploads/...
  if (s.startsWith("/chat/uploads/")) {
    s = s.replace(/^\/chat\/uploads\//, "/uploads/");
  }

  // only delete chat files
  if (!s.startsWith("/uploads/chat/")) {
    return null;
  }

  const filename = s.split("/").pop();

  if (!filename) return null;

  return path.join(upload.UPLOAD_ROOT, "chat", filename);
}

/* -------------------- Prisma helpers -------------------- */

function prismaModelExists(modelName) {
  try {
    return !!prisma?._runtimeDataModel?.models?.[modelName];
  } catch {
    return false;
  }
}

function prismaModelFields(modelName) {
  try {
    const model = prisma?._runtimeDataModel?.models?.[modelName];

    if (!model || !Array.isArray(model.fields)) {
      return new Set();
    }

    return new Set(model.fields.map((field) => field.name));
  } catch {
    return new Set();
  }
}

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

function buildDeliveredSelect() {
  const fields = prismaModelFields("delivered_orders");

  const select = {
    order_id: true,
  };

  if (fields.has("created_at")) {
    select.created_at = true;
  }

  if (fields.has("delivered_at")) {
    select.delivered_at = true;
  }

  if (fields.has("chat_cleaned")) {
    select.chat_cleaned = true;
  }

  if (fields.has("is_chat_cleaned")) {
    select.is_chat_cleaned = true;
  }

  if (fields.has("cleaned")) {
    select.cleaned = true;
  }

  return select;
}

function buildDeliveredOrderBy() {
  const fields = prismaModelFields("delivered_orders");

  if (fields.has("delivered_id")) {
    return [{ delivered_id: "desc" }];
  }

  if (fields.has("id")) {
    return [{ id: "desc" }];
  }

  if (fields.has("created_at")) {
    return [{ created_at: "desc" }];
  }

  if (fields.has("delivered_at")) {
    return [{ delivered_at: "desc" }];
  }

  return [{ order_id: "desc" }];
}

function buildDeliveredWhere() {
  const fields = prismaModelFields("delivered_orders");

  if (fields.has("chat_cleaned")) {
    return {
      OR: [{ chat_cleaned: false }, { chat_cleaned: 0 }],
    };
  }

  if (fields.has("is_chat_cleaned")) {
    return {
      OR: [{ is_chat_cleaned: false }, { is_chat_cleaned: 0 }],
    };
  }

  if (fields.has("cleaned")) {
    return {
      OR: [{ cleaned: false }, { cleaned: 0 }],
    };
  }

  // No cleaned flag exists. Redis idempotency will prevent repeat work.
  return {};
}

async function fetchDeliveredOrderIds(limit) {
  if (!prismaModelExists("delivered_orders")) {
    return {
      rows: [],
      mode: "Prisma model delivered_orders not found",
    };
  }

  const take = Math.max(1, Number(limit) || 50);

  const fields = prismaModelFields("delivered_orders");

  let mode = "fallback: delivered_orders";

  if (fields.has("chat_cleaned")) {
    mode = "chat_cleaned=false";
  } else if (fields.has("is_chat_cleaned")) {
    mode = "is_chat_cleaned=false";
  } else if (fields.has("cleaned")) {
    mode = "cleaned=false";
  }

  const rows = await prisma.delivered_orders.findMany({
    where: buildDeliveredWhere(),
    select: buildDeliveredSelect(),
    orderBy: buildDeliveredOrderBy(),
    take,
  });

  return {
    rows: rows.map(serializeRow),
    mode,
  };
}

async function markDbCleaned(orderId) {
  const oid = String(orderId || "").trim();

  if (!oid || !prismaModelExists("delivered_orders")) {
    return false;
  }

  const fields = prismaModelFields("delivered_orders");

  const data = {};

  if (fields.has("chat_cleaned")) {
    data.chat_cleaned = true;
  } else if (fields.has("is_chat_cleaned")) {
    data.is_chat_cleaned = true;
  } else if (fields.has("cleaned")) {
    data.cleaned = true;
  } else {
    return false;
  }

  try {
    const result = await prisma.delivered_orders.updateMany({
      where: {
        order_id: oid,
      },
      data,
    });

    return Number(result.count || 0) > 0;
  } catch (error) {
    logCleanupError("markDbCleaned failed", error, {
      orderId: oid,
    });

    return false;
  }
}

async function cleanupTick() {
  // lock: only one pod runs cleanup each tick
  if (typeof store.tryAcquireCleanupLock === "function") {
    const locked = await store.tryAcquireCleanupLock(25);
    if (!locked) return;
  }

  const batch = Math.max(1, Number(process.env.CLEANUP_BATCH_SIZE || 50));
  const graceMin = Number(process.env.CLEANUP_GRACE_MINUTES || 0);

  try {
    const { rows, mode } = await fetchDeliveredOrderIds(batch);

    if (!rows.length) return;

    logCleanup("poll", {
      found: rows.length,
      mode,
    });

    for (const row of rows) {
      const orderId = String(row.order_id || "").trim();

      if (!orderId) continue;

      // Optional grace period if delivered_orders has created_at/delivered_at
      const graceDate = row.created_at || row.delivered_at || null;

      if (graceMin > 0 && graceDate) {
        const ageMs = Date.now() - new Date(graceDate).getTime();

        if (ageMs < graceMin * 60 * 1000) {
          continue;
        }
      }

      if (typeof store.wasOrderCleaned === "function") {
        if (await store.wasOrderCleaned(orderId)) continue;
      }

      const result = await store.deleteConversationByOrderId(orderId, {
        deleteFiles: async (mediaUrls) => {
          const paths = [
            ...new Set(
              (mediaUrls || []).map(mediaUrlToDiskPath).filter(Boolean)
            ),
          ];

          let deleted = 0;

          for (const filePath of paths) {
            const ok = await safeUnlink(filePath);
            if (ok) deleted++;
          }

          if (paths.length) {
            logCleanup("deleted files", {
              orderId,
              deleted,
              attempted: paths.length,
            });
          }

          return deleted;
        },
      });

      if (result.deleted) {
        if (typeof store.markOrderCleaned === "function") {
          await store.markOrderCleaned(orderId);
        }

        await markDbCleaned(orderId);

        logCleanup("deleted chat", result);
      }
    }
  } catch (error) {
    logCleanupError("Chat cleanup tick failed", error);
  }
}

function startCleanupLoop() {
  const enabled = String(process.env.CLEANUP_ENABLED || "1") === "1";

  if (!enabled) {
    logCleanup("disabled (CLEANUP_ENABLED!=1)");
    return null;
  }

  const pollSec = Math.max(10, Number(process.env.CLEANUP_POLL_SECONDS || 60));

  logCleanup("started", {
    pollSec,
    batch: process.env.CLEANUP_BATCH_SIZE || 50,
    graceMin: process.env.CLEANUP_GRACE_MINUTES || 0,
    uploadRoot: upload.UPLOAD_ROOT,
  });

  setTimeout(() => cleanupTick().catch(() => null), 5000);

  const timer = setInterval(
    () => cleanupTick().catch(() => null),
    pollSec * 1000
  );

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return timer;
}

/* -------------------- Prisma connection check -------------------- */

async function checkPrismaConnection() {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    console.log("[prisma] connected successfully");

    logger.info("Chat service Prisma connected successfully", {
      module: "chat_service",
    });

    return true;
  } catch (error) {
    console.error("[prisma] connection failed", {
      message: error?.message,
      code: error?.code,
    });

    logger.error("Chat service Prisma connection failed", {
      module: "chat_service",
      message: error?.message,
      code: error?.code || null,
      stack: error?.stack || null,
    });

    return false;
  }
}

/* -------------------- graceful shutdown -------------------- */

async function shutdown(signal) {
  console.log(`[server] received ${signal}. Shutting down...`);

  logger.warn("Chat service shutdown signal received", {
    module: "shutdown",
    signal,
  });

  try {
    server.close(() => {
      console.log("[server] HTTP server closed");

      logger.info("Chat service HTTP server closed", {
        module: "shutdown",
      });
    });
  } catch (error) {
    console.error("[server] close error", error?.message || error);

    logger.error("Chat service server close error", {
      module: "shutdown",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  }

  try {
    await prisma.$disconnect();

    console.log("[prisma] disconnected");

    logger.info("Chat service Prisma disconnected", {
      module: "shutdown",
    });
  } catch (error) {
    console.error("[prisma] disconnect error", error?.message || error);

    logger.error("Chat service Prisma disconnect error", {
      module: "shutdown",
      message: error?.message || String(error),
      stack: error?.stack || null,
    });
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* -------------------- global process error handlers -------------------- */

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

/* -------------------- listen -------------------- */

async function startServer() {
  const prismaOk = await checkPrismaConnection();

  if (!prismaOk) {
    console.error("[server] Startup aborted because Prisma could not connect.");

    logger.error("Chat service startup aborted because Prisma could not connect", {
      module: "startup",
    });

    process.exit(1);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`chat running on port number: ${PORT}`);

    logger.info("Chat service started", {
      module: "chat_service",
      port: PORT,
    });

    startCleanupLoop();
  });
}

startServer().catch((error) => {
  console.error("[server] fatal startup error", {
    message: error?.message,
    code: error?.code,
    stack: error?.stack,
  });

  logger.error("Chat service fatal startup error", {
    module: "startup",
    message: error?.message,
    code: error?.code || null,
    stack: error?.stack || null,
  });

  process.exit(1);
});