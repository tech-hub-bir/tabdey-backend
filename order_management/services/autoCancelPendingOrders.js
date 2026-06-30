// services/autoCancelPendingOrders.js
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Keeps same business logic:
//    - scan PENDING orders older than timeout
//    - call Order.cancelAndArchiveOrder()
//    - broadcast status
//    - notify merchants
//    - notify user

const { prisma } = require("../lib/prisma");

const Order = require("../models/orderModels");

const {
  insertAndEmitNotification,
  broadcastOrderStatusToMany,
} = require("../realtime");

/**
 * Auto-cancel any order that remains PENDING longer than N minutes.
 *
 * ENV:
 *  - AUTO_CANCEL_PENDING_ORDERS=true|false   default true
 *  - PENDING_ORDER_TIMEOUT_MINUTES=60        default 60
 *  - PENDING_ORDER_SCAN_INTERVAL_SECONDS=60  default 60
 *  - PENDING_ORDER_SCAN_LIMIT=200            default 200
 */

function getEnabled() {
  return (
    String(process.env.AUTO_CANCEL_PENDING_ORDERS ?? "true")
      .trim()
      .toLowerCase() !== "false"
  );
}

function getTimeoutMinutes() {
  return Math.max(1, Number(process.env.PENDING_ORDER_TIMEOUT_MINUTES || 60));
}

function getIntervalSeconds() {
  return Math.max(
    15,
    Number(process.env.PENDING_ORDER_SCAN_INTERVAL_SECONDS || 60),
  );
}

function getScanLimit() {
  return Math.max(1, Number(process.env.PENDING_ORDER_SCAN_LIMIT || 200));
}

function buildCutoffDate(timeoutMinutes) {
  return new Date(Date.now() - timeoutMinutes * 60 * 1000);
}

function cleanOrderId(v) {
  return String(v || "").trim().toUpperCase();
}

function toPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function notifyMerchants({ order_id, user_id, business_ids, reason }) {
  for (const business_id of business_ids || []) {
    try {
      await insertAndEmitNotification({
        business_id,
        user_id,
        order_id,
        type: "order:status",
        title: `Order #${order_id} CANCELLED`,
        body_preview: reason,
      });
    } catch (e) {
      console.error("[AUTO_CANCEL notify merchant failed]", {
        order_id,
        business_id,
        err: e?.message,
      });
    }
  }
}

async function notifyUser({ order_id, user_id, reason }) {
  try {
    if (typeof Order.addUserOrderStatusNotification !== "function") {
      console.error(
        "[AUTO_CANCEL notify user skipped] Order.addUserOrderStatusNotification is not available",
      );
      return;
    }

    await Order.addUserOrderStatusNotification({
      user_id,
      order_id,
      status: "CANCELLED",
      reason,
    });
  } catch (e) {
    console.error("[AUTO_CANCEL notify user failed]", {
      order_id,
      user_id,
      err: e?.message,
    });
  }
}

function startPendingOrderAutoCanceller() {
  const enabled = getEnabled();

  if (!enabled) {
    console.log(
      "⏸️ Pending-order auto-canceller is disabled (AUTO_CANCEL_PENDING_ORDERS=false)",
    );

    return {
      stop: () => {},
    };
  }

  const timeoutMinutes = getTimeoutMinutes();
  const intervalSeconds = getIntervalSeconds();
  const limit = getScanLimit();

  let running = false;

  const runOnce = async () => {
    if (running) return;

    running = true;

    try {
      const cutoffDate = buildCutoffDate(timeoutMinutes);

      // Prisma equivalent of:
      // SELECT order_id, created_at
      // FROM orders
      // WHERE status = 'PENDING'
      // AND created_at <= cutoffDate
      // ORDER BY created_at ASC
      // LIMIT ?
      const rows = await prisma.orders.findMany({
        where: {
          status: "PENDING",
          created_at: {
            lte: cutoffDate,
          },
        },
        select: {
          order_id: true,
          created_at: true,
        },
        orderBy: {
          created_at: "asc",
        },
        take: limit,
      });

      if (!rows.length) return;

      for (const row of rows) {
        const order_id = cleanOrderId(row.order_id);

        if (!order_id) continue;

        const reason = `Auto-cancelled: store did not accept within ${timeoutMinutes} minutes.`;

        // IMPORTANT:
        // cancelAndArchiveOrder() must re-check onlyIfStatus = PENDING.
        // That prevents race condition if merchant accepts at the same time.
        let out = null;

        try {
          if (typeof Order.cancelAndArchiveOrder !== "function") {
            throw new Error("Order.cancelAndArchiveOrder is not available.");
          }

          out = await Order.cancelAndArchiveOrder(order_id, {
            cancelled_by: "SYSTEM",
            reason,
            onlyIfStatus: "PENDING",
          });
        } catch (e) {
          console.error("[AUTO_CANCEL cancelAndArchiveOrder failed]", {
            order_id,
            err: e?.message,
          });

          continue;
        }

        if (!out || !out.ok) {
          continue;
        }

        const user_id = toPositiveNumber(out.user_id);

        const business_ids = Array.isArray(out.business_ids)
          ? out.business_ids
              .map((x) => Number(x))
              .filter((n) => Number.isFinite(n) && n > 0)
          : [];

        // Broadcast to user + merchants
        try {
          broadcastOrderStatusToMany({
            order_id,
            user_id,
            business_ids,
            status: "CANCELLED",
          });
        } catch (e) {
          console.error("[AUTO_CANCEL broadcast failed]", {
            order_id,
            err: e?.message,
          });
        }

        // Merchant notification(s)
        await notifyMerchants({
          order_id,
          user_id,
          business_ids,
          reason,
        });

        // User notification
        if (user_id) {
          await notifyUser({
            order_id,
            user_id,
            reason,
          });
        }

        console.log(
          `🧹 Auto-cancelled order ${order_id} (PENDING > ${timeoutMinutes}m)`,
        );
      }
    } catch (e) {
      console.error("[AUTO_CANCEL runOnce ERROR]", e?.message || e);
    } finally {
      running = false;
    }
  };

  // Run immediately + on interval
  runOnce();

  const timer = setInterval(runOnce, intervalSeconds * 1000);

  // Allow process to exit normally
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  console.log(
    `✅ Pending-order auto-canceller started: timeout=${timeoutMinutes}m, scan_every=${intervalSeconds}s`,
  );

  return {
    stop: () => clearInterval(timer),
  };
}

module.exports = {
  startPendingOrderAutoCanceller,

  // exported for testing/debugging
  buildCutoffDate,
};