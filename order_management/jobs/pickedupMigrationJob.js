// jobs/pickedupMigrationJob.js
// ✅ Prisma version
// ✅ No raw db.query()
// ✅ Keeps same behavior:
//    - retries failed PICKUP receipt emails
//    - migrates PICKEDUP orders after 30 minutes
//    - sends pickup receipt email
//    - inserts into pickedup_orders + pickedup_order_items
//    - deletes from active orders + order_items

const { prisma } = require("../lib/prisma");
const PickupEmailService = require("../services/pickupEmailService");

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

function normalizeOrderId(v) {
  return String(v || "").trim().toUpperCase();
}

function getCutoffDate(minutes = 30) {
  return new Date(Date.now() - Number(minutes || 30) * 60 * 1000);
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

function extractPickupAddress(orderDeliveryAddress, businessAddress) {
  let pickupAddress = orderDeliveryAddress || businessAddress || "N/A";

  if (pickupAddress !== "N/A" && typeof pickupAddress === "string") {
    try {
      const parsed = JSON.parse(pickupAddress);
      pickupAddress = parsed?.address || pickupAddress;
    } catch {}
  }

  return pickupAddress;
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
      address: true,
      business_logo: true,
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
    menu_name:
      menuNameMap.get(Number(item.menu_id)) ||
      item.item_name ||
      `Item ${item.menu_id}`,
  }));
}

async function getPickedupOrderItems(orderId) {
  const oid = normalizeOrderId(orderId);
  if (!oid) return [];

  const rows = await prisma.pickedup_order_items.findMany({
    where: {
      order_id: oid,
    },
    orderBy: {
      pickedup_item_id: "asc",
    },
  });

  return rows.map(serializeRow);
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
      delivery_method: "PICKUP",
      created_at: new Date(),
      updated_at: new Date(),
    },
    update: {
      receipt_sent: true,
      receipt_sent_at: new Date(),
      email_status: "sent",
      error_message: null,
      delivery_method: "PICKUP",
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
      delivery_method: "PICKUP",
      retry_count: nextRetryCount,
      created_at: new Date(),
      updated_at: new Date(),
    },
    update: {
      email_status: "failed",
      error_message: String(error_message || "").slice(0, 1000),
      delivery_method: "PICKUP",
      retry_count: nextRetryCount,
      updated_at: new Date(),
    },
  });
}

async function incrementPickupReceiptRetry(orderId, errorMessage = null) {
  const order_id = normalizeOrderId(orderId);
  if (!order_id) return;

  await prisma.receipt_email.updateMany({
    where: {
      order_id,
      delivery_method: "PICKUP",
    },
    data: {
      retry_count: {
        increment: 1,
      },
      updated_at: new Date(),
      ...(errorMessage != null
        ? { error_message: String(errorMessage).slice(0, 1000) }
        : {}),
    },
  });
}

/* ============================================================
   Retry failed pickup emails
============================================================ */

async function retryFailedPickupEmails({
  batchSize = Number(process.env.PICKEDUP_MIGRATION_BATCH || 10),
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
        delivery_method: "PICKUP",
      },
      select: {
        order_id: true,
        user_email: true,
        business_name: true,
        error_message: true,
      },
      take,
    });

    if (!failedEmails.length) return;

    console.log(
      `[PICKUP RETRY] Retrying ${failedEmails.length} failed PICKUP emails`,
    );

    for (const failed of failedEmails) {
      const order_id = normalizeOrderId(failed.order_id);

      console.log(`[PICKUP RETRY] Retrying order ${order_id}`);

      try {
        const pickedOrderRaw = await prisma.pickedup_orders.findUnique({
          where: {
            order_id,
          },
        });

        if (!pickedOrderRaw) {
          console.log(`[PICKUP RETRY] Order ${order_id} not found`);
          continue;
        }

        const order = serializeRow(pickedOrderRaw);

        const user = (await getUserById(order.user_id)) || {};
        const business = (await getBusinessById(order.business_id)) || {};

        const items = await getPickedupOrderItems(order_id);

        const subtotal = items.reduce(
          (total, item) => total + toNumber(item.subtotal, 0),
          0,
        );

        const grandTotal = toNumber(order.total_amount, subtotal);

        const businessLogo = buildBusinessLogoUrl(business.business_logo);

        const orderData = {
          order_id: order.order_id,
          created_at: order.original_created_at,
          pickedup_at: order.pickedup_at,
          payment_method: order.payment_method,
          pickup_address: order.pickup_address,

          customer_name: user.user_name || "Customer",
          customer_email: user.email || failed.user_email,
          customer_phone: user.phone || "N/A",

          business_name: order.business_name || business.business_name,
          business_logo: businessLogo,
          business_address: business.address || "Thimphu, Bhutan",

          items: items.map((item) => ({
            menu_name: item.item_name,
            quantity: toInt(item.quantity, 0),
            price_per_unit: toNumber(item.price, 0),
            subtotal: toNumber(item.subtotal, 0),
          })),

          subtotal,
          grand_total: grandTotal,
        };

        const emailResult =
          await PickupEmailService.sendPickupReceipt(orderData);

        if (emailResult.success) {
          await prisma.receipt_email.updateMany({
            where: {
              order_id,
              delivery_method: "PICKUP",
            },
            data: {
              receipt_sent: true,
              receipt_sent_at: new Date(),
              email_status: "sent",
              error_message: null,
              updated_at: new Date(),
            },
          });

          console.log(
            `[PICKUP RETRY] ✅ Email resent successfully for ${order_id}`,
          );
        } else {
          await incrementPickupReceiptRetry(order_id, emailResult.error);

          console.log(
            `[PICKUP RETRY] ❌ Failed again for ${order_id}: ${emailResult.error}`,
          );
        }
      } catch (error) {
        console.error(`[PICKUP RETRY] Error for ${order_id}:`, error.message);

        await incrementPickupReceiptRetry(order_id, error.message);
      }
    }
  } catch (e) {
    console.error("[PICKUP RETRY] Batch error:", e.message);
  }
}

/* ============================================================
   Main migration
============================================================ */

async function migratePICKEDUPOrdersOnce({
  batchSize = Number(process.env.PICKEDUP_MIGRATION_BATCH || 50),
} = {}) {
  if (_running) return;

  _running = true;

  try {
    const take = Math.max(1, Number(batchSize) || 50);
    const cutoff = getCutoffDate(30);

    /*
      Old SQL:
      SELECT orders where:
      - UPPER(status) = PICKEDUP
      - pickedup_at IS NOT NULL
      - pickedup_at <= NOW() - 30 MINUTE
      - pickedup_orders does not already contain order_id
    */
    const candidatesRaw = await prisma.orders.findMany({
      where: {
        status: {
          in: ["PICKEDUP", "Pickedup", "pickedup"],
        },
        pickedup_at: {
          not: null,
          lte: cutoff,
        },
      },
      select: {
        order_id: true,
        user_id: true,
        total_amount: true,
        created_at: true,
        payment_method: true,
        delivery_address: true,
        status: true,
        business_id: true,
        updated_at: true,
        discount_amount: true,
        pickedup_by: true,
        pickedup_at: true,
      },
      orderBy: {
        pickedup_at: "asc",
      },
      take: take * 3,
    });

    if (!candidatesRaw.length) {
      console.log("[PICKEDUP MIGRATION] No orders to process");
      return;
    }

    const candidates = candidatesRaw.map(serializeRow);
    const orderIds = candidates.map((o) => o.order_id);

    const existingPickedRows = await prisma.pickedup_orders.findMany({
      where: {
        order_id: {
          in: orderIds,
        },
      },
      select: {
        order_id: true,
      },
    });

    const alreadyPicked = new Set(existingPickedRows.map((r) => r.order_id));

    const rows = candidates
      .filter((o) => !alreadyPicked.has(o.order_id))
      .slice(0, take);

    if (!rows.length) {
      console.log("[PICKEDUP MIGRATION] No orders to process");
      return;
    }

    console.log(`[PICKEDUP MIGRATION] Found ${rows.length} orders to process`);

    for (const order of rows) {
      const order_id = normalizeOrderId(order.order_id);

      if (!order_id) {
        console.error("[PICKEDUP MIGRATION] Skipping: order_id is null");
        continue;
      }

      try {
        console.log(`[PICKEDUP MIGRATION] Processing order ${order_id}`);

        const business = (await getBusinessById(order.business_id)) || {};
        const user = (await getUserById(order.user_id)) || {};

        const items = await getOrderItemsWithMenuNames(order_id);

        if (!items.length) {
          console.error(
            `[PICKEDUP MIGRATION] No items found for order ${order_id}`,
          );
          continue;
        }

        const subtotal = items.reduce((total, item) => {
          const price = toNumber(item.price, 0);
          const quantity = toInt(item.quantity, 0);
          return total + price * quantity;
        }, 0);

        const grandTotal = toNumber(order.total_amount, subtotal);

        const businessLogo = buildBusinessLogoUrl(business.business_logo);

        const pickupAddress = extractPickupAddress(
          order.delivery_address,
          business.address,
        );

        const orderData = {
          order_id,
          created_at: order.created_at,
          pickedup_at: order.pickedup_at || new Date(),
          payment_method: order.payment_method,
          pickup_address: pickupAddress,
          status: "PICKEDUP",

          customer_name: user.user_name || "Customer",
          customer_email: user.email,
          customer_phone: user.phone || "N/A",

          business_name: business.business_name || "TàbDey",
          business_logo: businessLogo,
          business_address: business.address || "Thimphu, Bhutan",

          items: items.map((item) => ({
            menu_name: item.menu_name || `Item ${item.menu_id}`,
            quantity: toInt(item.quantity, 0),
            price_per_unit: toNumber(item.price, 0),
            subtotal: toNumber(item.price, 0) * toInt(item.quantity, 0),
          })),

          subtotal,
          grand_total: grandTotal,
        };

        console.log(
          `[PICKEDUP MIGRATION] Sending pickup email to ${user.email}...`,
        );

        const emailResult =
          await PickupEmailService.sendPickupReceipt(orderData);

        if (emailResult.success) {
          await upsertReceiptSent({
            order_id,
            user_id: order.user_id,
            business_id: order.business_id,
            user_email: user.email,
            user_name: user.user_name,
            business_name: business.business_name,
          });

          console.log(
            `[PICKEDUP MIGRATION] ✅ Email sent for order ${order_id}`,
          );
        } else {
          await upsertReceiptFailed({
            order_id,
            user_id: order.user_id,
            business_id: order.business_id,
            user_email: user.email,
            user_name: user.user_name,
            business_name: business.business_name,
            error_message: emailResult.error,
            incrementRetry: true,
          });

          console.error(
            `[PICKEDUP MIGRATION] ❌ Email failed for order ${order_id}:`,
            emailResult.error,
          );
        }

        /*
          Insert archive rows and remove active order in one transaction.
          To avoid duplicate pickedup_order_items if a partial retry happens,
          delete existing pickedup_order_items first before createMany.
        */
        await prisma.$transaction(async (tx) => {
          await tx.pickedup_order_items.deleteMany({
            where: {
              order_id,
            },
          });

          await tx.pickedup_orders.upsert({
            where: {
              order_id,
            },
            create: {
              order_id,
              user_id: toInt(order.user_id),
              business_id: toInt(order.business_id),
              business_name: business.business_name || "Unknown Business",
              status: "PICKEDUP",

              total_amount: order.total_amount,
              discount_amount: order.discount_amount || 0,
              payment_method: order.payment_method,
              pickup_address: pickupAddress,

              pickedup_by:
                order.pickedup_by || user.user_name || "CUSTOMER",
              pickedup_at: order.pickedup_at || new Date(),

              original_created_at: order.created_at || new Date(),
              original_updated_at: order.updated_at || new Date(),

              created_at: new Date(),
              updated_at: new Date(),
            },
            update: {
              user_id: toInt(order.user_id),
              business_id: toInt(order.business_id),
              business_name: business.business_name || "Unknown Business",
              status: "PICKEDUP",

              total_amount: order.total_amount,
              discount_amount: order.discount_amount || 0,
              payment_method: order.payment_method,
              pickup_address: pickupAddress,

              pickedup_by:
                order.pickedup_by || user.user_name || "CUSTOMER",
              pickedup_at: order.pickedup_at || new Date(),

              original_created_at: order.created_at || new Date(),
              original_updated_at: order.updated_at || new Date(),

              updated_at: new Date(),
            },
          });

          await tx.pickedup_order_items.createMany({
            data: items.map((item) => {
              const itemSubtotal =
                toNumber(item.price, 0) * toInt(item.quantity, 0);

              return {
                order_id,
                business_id: toInt(item.business_id || order.business_id),
                business_name: business.business_name || "Unknown Business",
                menu_id:
                  item.menu_id != null ? toInt(item.menu_id, null) : null,
                item_name: item.menu_name || `Item ${item.menu_id}`,
                item_image: item.item_image || null,
                quantity: toInt(item.quantity, 1),
                price: item.price,
                subtotal: itemSubtotal,
                created_at: new Date(),
              };
            }),
          });

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

        console.log(
          `[PICKEDUP MIGRATION] ✅ Successfully migrated order ${order_id}`,
        );
      } catch (e) {
        console.error(
          `[PICKEDUP MIGRATION] ❌ Failed for order ${order_id}:`,
          e.message,
        );
      }
    }
  } catch (e) {
    console.error("[PICKEDUP MIGRATION] Batch error:", e.message);
  } finally {
    _running = false;
  }
}

/* ============================================================
   Start / stop
============================================================ */

function startPickedupMigrationJob({
  intervalMs = Number(process.env.PICKEDUP_MIGRATION_INTERVAL_MS || 60000),
  batchSize = Number(process.env.PICKEDUP_MIGRATION_BATCH || 50),
} = {}) {
  if (_timer) return;

  console.log("🚀 Starting Pickedup Migration Job...");
  console.log(`   Interval: ${intervalMs / 1000}s`);
  console.log(`   Batch Size: ${batchSize}`);

  migratePICKEDUPOrdersOnce({ batchSize }).catch(console.error);

  _timer = setInterval(() => {
    migratePICKEDUPOrdersOnce({ batchSize }).catch(console.error);
    retryFailedPickupEmails({ batchSize: 10 }).catch(console.error);
  }, intervalMs);

  if (typeof _timer.unref === "function") {
    _timer.unref();
  }

  console.log("✅ Pickedup migration job started");

  const stop = () => {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
      console.log("🛑 Pickedup migration job stopped");
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

module.exports = {
  startPickedupMigrationJob,
  migratePICKEDUPOrdersOnce,
  retryFailedPickupEmails,
};