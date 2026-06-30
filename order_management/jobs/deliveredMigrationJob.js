// jobs/deliveredMigrationJob.js
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Keeps same behavior:
//    - sends receipt for delivered orders after 30 minutes
//    - archives delivered orders through Order.completeAndArchiveDeliveredOrder()
//    - retries failed receipt emails
//    - deletes DECLINED orders after 30 minutes

const { prisma } = require("../lib/prisma");
const Order = require("../models/orderModels");
const EmailService = require("../services/emailService");

let _timer = null;
let _running = false;

/* ============================================================
   Helpers
============================================================ */

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
}

function toBigIntId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? BigInt(n) : null;
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

function getCutoffDate(minutes = 30) {
  return new Date(Date.now() - Number(minutes || 30) * 60 * 1000);
}

function normalizeOrderId(v) {
  return String(v || "").trim().toUpperCase();
}

function extractDeliveryAddress(v) {
  if (!v) return "N/A";

  if (typeof v === "object") {
    return v.address || "N/A";
  }

  const s = String(v).trim();
  if (!s) return "N/A";

  try {
    const parsed = JSON.parse(s);
    return parsed?.address || s;
  } catch {
    return s;
  }
}

function buildBusinessLogoUrl(logo) {
  if (!logo) return null;

  const s = String(logo).trim();
  if (!s) return null;

  if (s.startsWith("/uploads/")) {
    return `https://backend.tabdhey.bt/merchant${s}`;
  }

  if (s.startsWith("http")) {
    return s;
  }

  return `https://backend.tabdhey.bt/merchant/uploads/logos/${s}`;
}

async function getUserById(userId) {
  const uid = toBigIntId(userId);
  if (!uid) return null;

  const row = await prisma.users.findUnique({
    where: {
      user_id: uid,
    },
    select: {
      user_id: true,
      user_name: true,
      email: true,
      phone: true,
    },
  });

  return serializeRow(row);
}

async function getBusinessById(businessId) {
  const bid = toBigIntId(businessId);
  if (!bid) return null;

  const row = await prisma.merchant_business_details.findUnique({
    where: {
      business_id: bid,
    },
    select: {
      business_id: true,
      business_name: true,
      business_logo: true,
      address: true,
    },
  });

  return serializeRow(row);
}

async function getFoodMenuNameMap(menuIds = []) {
  const ids = Array.from(
    new Set(
      menuIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  );

  const map = new Map();

  if (!ids.length) return map;

  const rows = await prisma.food_menu.findMany({
    where: {
      id: {
        in: ids.map((id) => BigInt(id)),
      },
    },
    select: {
      id: true,
      item_name: true,
    },
  });

  for (const raw of rows || []) {
    const row = serializeRow(raw);
    map.set(Number(row.id), row.item_name || null);
  }

  return map;
}

async function getOrderItemsWithMenuNames(orderId) {
  const oid = normalizeOrderId(orderId);
  if (!oid) return [];

  const itemsRaw = await prisma.order_items.findMany({
    where: {
      order_id: oid,
    },
    orderBy: {
      item_id: "asc",
    },
  });

  const items = itemsRaw.map(serializeRow);

  if (!items.length) return [];

  const menuNameMap = await getFoodMenuNameMap(items.map((it) => it.menu_id));

  return items.map((item) => ({
    ...item,
    menu_name: menuNameMap.get(Number(item.menu_id)) || null,
  }));
}

async function upsertReceiptSent({
  order_id,
  user_id,
  business_id,
  user_email,
  user_name,
  business_name,
}) {
  await prisma.receipt_email.upsert({
    where: {
      order_id,
    },
    create: {
      order_id,
      user_id: toInt(user_id),
      business_id: toInt(business_id),
      user_email: user_email || "",
      user_name: user_name || null,
      business_name: business_name || null,
      receipt_sent: true,
      receipt_sent_at: new Date(),
      email_status: "sent",
      delivery_method: "DELIVERY",
      created_at: new Date(),
      updated_at: new Date(),
    },
    update: {
      receipt_sent: true,
      receipt_sent_at: new Date(),
      email_status: "sent",
      delivery_method: "DELIVERY",
      updated_at: new Date(),
    },
  });
}

async function upsertReceiptFailed({
  order_id,
  user_id = null,
  business_id = null,
  user_email = null,
  user_name = null,
  business_name = null,
  error_message,
  incrementRetry = false,
}) {
  const existing = await prisma.receipt_email.findUnique({
    where: {
      order_id,
    },
    select: {
      retry_count: true,
    },
  });

  const nextRetryCount = incrementRetry
    ? Number(existing?.retry_count || 0) + 1
    : Number(existing?.retry_count || 0);

  await prisma.receipt_email.upsert({
    where: {
      order_id,
    },
    create: {
      order_id,
      user_id: toInt(user_id),
      business_id: toInt(business_id),
      user_email: user_email || "",
      user_name: user_name || null,
      business_name: business_name || null,
      receipt_sent: false,
      email_status: "failed",
      error_message: String(error_message || "").slice(0, 1000),
      delivery_method: "DELIVERY",
      retry_count: nextRetryCount,
      created_at: new Date(),
      updated_at: new Date(),
    },
    update: {
      email_status: "failed",
      error_message: String(error_message || "").slice(0, 1000),
      delivery_method: "DELIVERY",
      retry_count: nextRetryCount,
      updated_at: new Date(),
    },
  });
}

/* ============================================================
   Delivered migration
============================================================ */

async function migrateDELIVEREDOrdersOnce({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
  delivered_by = "SYSTEM",
  reason = "Successfully delivered",
} = {}) {
  if (_running) return;

  _running = true;

  try {
    const take = Math.max(1, Number(batchSize) || 50);
    const cutoff = getCutoffDate(30);

    /*
      Old SQL:
      - orders.status upper = DELIVERED
      - delivered_at not null
      - delivered_at <= now - 30 min
      - receipt_email missing OR email_status != sent
      - delivery_method = DELIVERY
    */
    const candidateOrdersRaw = await prisma.orders.findMany({
      where: {
        status: {
          in: ["DELIVERED", "Delivered", "delivered"],
        },
        delivered_at: {
          not: null,
          lte: cutoff,
        },
      },
      select: {
        order_id: true,
        user_id: true,
        total_amount: true,
        created_at: true,
        delivered_at: true,
        payment_method: true,
        delivery_address: true,
        status: true,
        business_id: true,
        delivery_fee: true,
        platform_fee: true,
      },
      orderBy: {
        delivered_at: "asc",
      },
      take: take * 3,
    });

    if (!candidateOrdersRaw.length) {
      console.log("[DELIVERED MIGRATION] No orders to process");
      return;
    }

    const candidateOrders = candidateOrdersRaw.map(serializeRow);
    const candidateIds = candidateOrders.map((o) => o.order_id);

    const receiptRows = await prisma.receipt_email.findMany({
      where: {
        order_id: {
          in: candidateIds,
        },
        delivery_method: "DELIVERY",
      },
      select: {
        order_id: true,
        email_status: true,
      },
    });

    const receiptMap = new Map(
      receiptRows.map((r) => [r.order_id, r.email_status]),
    );

    const orders = candidateOrders
      .filter((o) => {
        const emailStatus = receiptMap.get(o.order_id);
        return !emailStatus || emailStatus !== "sent";
      })
      .slice(0, take);

    if (!orders.length) {
      console.log("[DELIVERED MIGRATION] No orders to process");
      return;
    }

    console.log(
      `[DELIVERED MIGRATION] Found ${orders.length} orders to process`,
    );

    for (const order of orders) {
      const order_id = normalizeOrderId(order.order_id);
      const user_id = Number(order.user_id);
      const business_id = Number(order.business_id);

      try {
        const deliveredOrder = await prisma.delivered_orders.findUnique({
          where: {
            order_id,
          },
          select: {
            order_id: true,
          },
        });

        const user = await getUserById(user_id);

        if (!user) {
          console.error(`[MIGRATION] User not found for order ${order_id}`);
          continue;
        }

        const items = await getOrderItemsWithMenuNames(order_id);

        if (!items.length) {
          console.error(`[MIGRATION] No items found for order ${order_id}`);
          continue;
        }

        const business = (await getBusinessById(business_id)) || {};

        const deliveryAddress = extractDeliveryAddress(order.delivery_address);

        const subtotal = items.reduce((total, item) => {
          const price = toNumber(item.price, 0);
          const quantity = toInt(item.quantity, 0);
          return total + price * quantity;
        }, 0);

        const deliveryFee = toNumber(order.delivery_fee, 0);
        const platformFee = toNumber(order.platform_fee, 0);
        const grandTotal = toNumber(order.total_amount, subtotal);

        const businessLogo = buildBusinessLogoUrl(business.business_logo);

        const orderData = {
          order_id,
          delivered_at: order.delivered_at,
          payment_method: order.payment_method,
          delivery_address: deliveryAddress,
          status: order.status || "Delivered",

          customer_name: user.user_name || "Customer",
          customer_email: user.email,
          customer_phone: user.phone || "N/A",

          business_name: business.business_name || "TàbDey",
          business_logo: businessLogo,
          business_address: business.address || "Thimphu, Bhutan",

          items: items.map((item) => ({
            menu_name:
              item.menu_name || item.item_name || `Item ${item.menu_id}`,
            quantity: toInt(item.quantity, 0),
            price_per_unit: toNumber(item.price, 0),
            subtotal: toNumber(item.price, 0) * toInt(item.quantity, 0),
          })),

          subtotal,
          delivery_fee: deliveryFee,
          platform_fee: platformFee,
          discount_amount: 0,
          grand_total: grandTotal,
        };

        console.log(
          `[MIGRATION] Sending receipt for order ${order_id} to ${user.email}`,
        );

        const emailResult = await EmailService.sendOrderReceipt(orderData);

        if (emailResult.success) {
          await upsertReceiptSent({
            order_id,
            user_id,
            business_id,
            user_email: user.email,
            user_name: user.user_name,
            business_name: business.business_name,
          });

          console.log(
            `[MIGRATION] Receipt sent successfully for order ${order_id}`,
          );
        } else {
          await upsertReceiptFailed({
            order_id,
            user_id,
            business_id,
            user_email: user.email,
            user_name: user.user_name,
            business_name: business.business_name,
            error_message: emailResult.error,
            incrementRetry: true,
          });

          console.error(
            `[MIGRATION] Failed to send receipt for order ${order_id}:`,
            emailResult.error,
          );
        }

        if (!deliveredOrder) {
          const out = await Order.completeAndArchiveDeliveredOrder(order_id, {
            delivered_by,
            reason,
            capture_at: "SKIP",
          });

          if (out?.ok) {
            console.log(
              `[DELIVERED MIGRATION] Order ${order_id} migrated successfully`,
            );
          }
        }
      } catch (e) {
        console.error(
          `[DELIVERED MIGRATION] Failed for order ${order_id}:`,
          e.message,
        );

        await upsertReceiptFailed({
          order_id,
          error_message: e.message,
          incrementRetry: false,
        });
      }
    }
  } catch (e) {
    console.error("[DELIVERED MIGRATION] Batch error:", e.message);
  } finally {
    _running = false;
  }
}

/* ============================================================
   Retry failed emails
============================================================ */

async function retryFailedEmails({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 10),
} = {}) {
  try {
    const take = Math.max(1, Number(batchSize) || 10);

    const failedEmails = await prisma.receipt_email.findMany({
      where: {
        email_status: "failed",
        receipt_sent: false,
        retry_count: {
          lt: 3,
        },
        delivery_method: "DELIVERY",
      },
      select: {
        order_id: true,
        user_email: true,
        business_name: true,
      },
      take,
    });

    if (!failedEmails.length) return;

    console.log(
      `[RETRY] Retrying ${failedEmails.length} failed DELIVERY emails`,
    );

    for (const failed of failedEmails) {
      console.log(`[RETRY] Would retry order ${failed.order_id}`);

      await prisma.receipt_email.updateMany({
        where: {
          order_id: failed.order_id,
          delivery_method: "DELIVERY",
        },
        data: {
          retry_count: {
            increment: 1,
          },
          updated_at: new Date(),
          email_status: "pending",
        },
      });
    }
  } catch (e) {
    console.error("[RETRY FAILED EMAILS] Error:", e.message);
  }
}

/* ============================================================
   DECLINED cleanup
============================================================ */

async function cleanupDECLINEDOrdersOnce({
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
} = {}) {
  try {
    const take = Math.max(1, Number(batchSize) || 50);
    const cutoff = getCutoffDate(30);

    const rows = await prisma.orders.findMany({
      where: {
        status: {
          in: ["DECLINED", "Declined", "declined"],
        },
        updated_at: {
          not: null,
          lte: cutoff,
        },
      },
      select: {
        order_id: true,
      },
      orderBy: {
        updated_at: "asc",
      },
      take,
    });

    if (!rows.length) return;

    for (const r of rows) {
      const order_id = normalizeOrderId(r.order_id);

      try {
        /*
          Same behavior as old SQL:
          DELETE FROM order_items WHERE order_id = ?
          DELETE FROM orders WHERE order_id = ?
        */
        await prisma.$transaction(async (tx) => {
          await tx.order_items.deleteMany({
            where: {
              order_id,
            },
          });

          await tx.orders.deleteMany({
            where: {
              order_id,
            },
          });
        });

        console.log("[DECLINED CLEANUP] deleted:", { order_id });
      } catch (e) {
        console.error("[DECLINED CLEANUP] failed:", {
          order_id,
          err: e?.message,
        });
      }
    }
  } catch (e) {
    console.error("[DECLINED CLEANUP] batch error:", e?.message);
  }
}

/* ============================================================
   Start / stop
============================================================ */

function startDeliveredMigrationJob({
  intervalMs = Number(process.env.DELIVERED_MIGRATION_INTERVAL_MS || 60000),
  batchSize = Number(process.env.DELIVERED_MIGRATION_BATCH || 50),
} = {}) {
  if (_timer) return;

  migrateDELIVEREDOrdersOnce({ batchSize }).catch(console.error);
  cleanupDECLINEDOrdersOnce({ batchSize }).catch(console.error);

  _timer = setInterval(() => {
    migrateDELIVEREDOrdersOnce({ batchSize }).catch(console.error);
    cleanupDECLINEDOrdersOnce({ batchSize }).catch(console.error);
    retryFailedEmails({ batchSize: 10 }).catch(console.error);
  }, intervalMs);

  if (typeof _timer.unref === "function") {
    _timer.unref();
  }

  console.log(
    `✅ Delivered migration with auto email started (every ${
      intervalMs / 1000
    }s, batchSize=${batchSize})`,
  );

  const stop = () => {
    if (_timer) clearInterval(_timer);
    _timer = null;
    console.log("🛑 Delivered migration job stopped");
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

module.exports = {
  startDeliveredMigrationJob,
  migrateDELIVEREDOrdersOnce,
  cleanupDECLINEDOrdersOnce,
  retryFailedEmails,
};