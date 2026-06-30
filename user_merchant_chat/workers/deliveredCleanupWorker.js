// Auto cleanup: poll delivered_orders and delete chats + images
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Redis chat cleanup remains unchanged

require("dotenv").config();

const path = require("path");
const fs = require("fs/promises");

const { prisma } = require("../lib/prisma");
const store = require("../models/chatStoreRedis");
const upload = require("../middlewares/upload");

function ts() {
  return new Date().toISOString();
}

function log(...a) {
  console.log(`[${ts()}] [cleanup]`, ...a);
}

async function safeUnlink(p) {
  try {
    await fs.unlink(p);
    return true;
  } catch {
    return false;
  }
}

function mediaUrlToDiskPath(mediaUrl) {
  if (!mediaUrl) return null;

  let s = String(mediaUrl).trim();

  if (!s) return null;

  // strip host if absolute
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      s = new URL(s).pathname;
    }
  } catch {}

  // normalize "/chat/uploads/.." -> "/uploads/.."
  if (s.startsWith("/chat/uploads/")) {
    s = s.replace(/^\/chat\/uploads\//, "/uploads/");
  }

  // only delete chat folder files
  if (!s.startsWith("/uploads/chat/")) {
    return null;
  }

  const filename = s.split("/").pop();

  if (!filename) return null;

  // disk path: <UPLOAD_ROOT>/chat/<filename>
  return path.join(upload.UPLOAD_ROOT, "chat", filename);
}

/* ============================================================
   Prisma schema helpers
============================================================ */

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

    return new Set(model.fields.map((f) => f.name));
  } catch {
    return new Set();
  }
}

function hasDeliveredField(fieldName) {
  return prismaModelFields("delivered_orders").has(fieldName);
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

function buildDeliveredOrderBy() {
  const fields = prismaModelFields("delivered_orders");

  if (fields.has("delivered_id")) {
    return [{ delivered_id: "asc" }];
  }

  if (fields.has("id")) {
    return [{ id: "asc" }];
  }

  if (fields.has("created_at")) {
    return [{ created_at: "desc" }];
  }

  if (fields.has("delivered_at")) {
    return [{ delivered_at: "desc" }];
  }

  return [{ order_id: "asc" }];
}

function buildDeliveredSelect() {
  const fields = prismaModelFields("delivered_orders");

  const select = {
    order_id: true,
  };

  if (fields.has("created_at")) {
    select.created_at = true;
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

function buildDeliveredWhereForCleanup() {
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

  // No cleaned flag exists: fallback to polling delivered_orders.
  return {};
}

/**
 * Fetch delivered order ids.
 *
 * Old SQL tried several variants:
 * - chat_cleaned=0
 * - is_chat_cleaned=0
 * - cleaned=0
 * - fallback all delivered_orders
 *
 * Prisma version checks actual generated Prisma fields and uses only existing fields.
 */
async function fetchDeliveredOrderIds(limit) {
  if (!prismaModelExists("delivered_orders")) {
    return {
      rows: [],
      modeSql: "Prisma model delivered_orders not found",
    };
  }

  const take = Math.max(1, Number(limit) || 50);
  const fields = prismaModelFields("delivered_orders");

  let mode = "fallback: all delivered_orders";

  if (fields.has("chat_cleaned")) {
    mode = "chat_cleaned=false";
  } else if (fields.has("is_chat_cleaned")) {
    mode = "is_chat_cleaned=false";
  } else if (fields.has("cleaned")) {
    mode = "cleaned=false";
  }

  const rowsRaw = await prisma.delivered_orders.findMany({
    where: buildDeliveredWhereForCleanup(),
    select: buildDeliveredSelect(),
    orderBy: buildDeliveredOrderBy(),
    take,
  });

  return {
    rows: rowsRaw.map(serializeRow),
    modeSql: mode,
  };
}

/**
 * Mark delivered order chat as cleaned if the schema supports a cleaned flag.
 */
async function markDbCleaned(orderId) {
  const oid = String(orderId || "").trim();

  if (!oid) return false;

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
  } catch (e) {
    log("markDbCleaned failed", {
      orderId: oid,
      error: e?.message,
    });

    return false;
  }
}

/* ============================================================
   Cleanup logic
============================================================ */

async function cleanupOne(orderId) {
  // idempotency: skip if already cleaned in Redis
  if (await store.wasOrderCleaned(orderId)) {
    return {
      skipped: true,
      orderId,
      reason: "already_cleaned(redis)",
    };
  }

  const del = await store.deleteConversationByOrderId(orderId, {
    deleteFiles: async (mediaUrls) => {
      const paths = [
        ...new Set(mediaUrls.map(mediaUrlToDiskPath).filter(Boolean)),
      ];

      if (paths.length) {
        log("deleting files", {
          orderId,
          count: paths.length,
        });
      }

      let ok = 0;

      for (const p of paths) {
        const did = await safeUnlink(p);
        if (did) ok++;
      }

      return ok;
    },
  });

  if (del.deleted) {
    await store.markOrderCleaned(orderId);
    await markDbCleaned(orderId);
  } else {
    // Do not mark cleaned if chat does not exist yet.
    // Leave it for next runs.
  }

  return del;
}

async function tick() {
  const limit = Math.max(1, Number(process.env.CLEANUP_BATCH_SIZE || 50));
  const graceMin = Number(process.env.CLEANUP_GRACE_MINUTES || 0);

  const { rows, modeSql } = await fetchDeliveredOrderIds(limit);

  log("poll", {
    found: rows.length,
    modeSql,
  });

  for (const r of rows) {
    const orderId = String(r.order_id || "").trim();

    if (!orderId) continue;

    // Optional grace period support if delivered_orders has created_at
    if (graceMin > 0 && r.created_at) {
      const ageMs = Date.now() - new Date(r.created_at).getTime();

      if (ageMs < graceMin * 60 * 1000) {
        continue;
      }
    }

    const res = await cleanupOne(orderId);

    log("cleanup result", res);
  }
}

async function main() {
  const intervalSec = Math.max(
    5,
    Number(process.env.CLEANUP_POLL_SECONDS || 30),
  );

  log("worker started", {
    intervalSec,
    batch: process.env.CLEANUP_BATCH_SIZE || 50,
    graceMin: process.env.CLEANUP_GRACE_MINUTES || 0,
    uploadRoot: upload.UPLOAD_ROOT,
  });

  // run immediately, then interval
  await tick().catch((e) =>
    log("tick error", {
      message: e?.message,
      code: e?.code,
      stack: e?.stack,
    }),
  );

  const timer = setInterval(
    () =>
      tick().catch((e) =>
        log("tick error", {
          message: e?.message,
          code: e?.code,
          stack: e?.stack,
        }),
      ),
    intervalSec * 1000,
  );

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

main().catch((e) => {
  log("fatal", {
    message: e?.message,
    code: e?.code,
    stack: e?.stack,
  });

  process.exit(1);
});