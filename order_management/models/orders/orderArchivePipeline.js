// orders/orderArchivePipeline.js
const db = require("../../config/db");
const {
  ensureStatusReasonSupport,
  ensureDeliveryExtrasSupport,
} = require("./schemaSupport");
const { resolveOrderServiceType } = require("./serviceTypeResolver");
const { awardPointsForCompletedOrderWithConn } = require("./pointsEngine");
const {
  insertMerchantEarningWithConn,
  insertFoodMartRevenueWithConn,
  buildItemsSummary,
} = require("./revenueSnapshot");
const {
  captureOrderFundsWithConn,
  captureOrderCODFeeWithConn,
  prefetchTxnIdsBatch,
} = require("./walletCaptureEngine");

/* ================= ARCHIVE HELPERS ================= */
async function tableExists(table, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT 1
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
     LIMIT 1
    `,
    [table],
  );
  return rows.length > 0;
}

async function getTableColumns(table, conn = null) {
  const dbh = conn || db;
  const [rows] = await dbh.query(
    `
    SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
    `,
    [table],
  );
  return new Set(rows.map((r) => String(r.COLUMN_NAME)));
}

function pick(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

async function archiveCancelledOrderInternal(
  conn,
  order_id,
  { cancelled_by = "SYSTEM", reason = "" } = {},
) {
  const hasCancelledOrders = await tableExists("cancelled_orders", conn);
  const hasCancelledItems = await tableExists("cancelled_order_items", conn);
  if (!hasCancelledOrders && !hasCancelledItems) return { archived: false };

  const [[order]] = await conn.query(
    `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
    [order_id],
  );
  if (!order) return { archived: false };

  const [items] = await conn.query(
    `SELECT * FROM order_items WHERE order_id = ?`,
    [order_id],
  );

  let resolvedServiceType = null;
  try {
    resolvedServiceType = await resolveOrderServiceType(order_id, conn);
  } catch {
    resolvedServiceType =
      (order.service_type ? String(order.service_type).toUpperCase() : null) ||
      "FOOD";
  }

  if (hasCancelledOrders) {
    const cols = await getTableColumns("cancelled_orders", conn);
    const row = {};

    if (cols.has("order_id")) row.order_id = order.order_id;
    if (cols.has("user_id")) row.user_id = order.user_id;
    if (cols.has("service_type"))
      row.service_type = resolvedServiceType || null;

    if (cols.has("payment_method")) row.payment_method = order.payment_method;
    if (cols.has("total_amount")) row.total_amount = order.total_amount;
    if (cols.has("discount_amount"))
      row.discount_amount = order.discount_amount;
    if (cols.has("delivery_fee")) row.delivery_fee = order.delivery_fee;
    if (cols.has("merchant_delivery_fee"))
      row.merchant_delivery_fee = order.merchant_delivery_fee;
    if (cols.has("platform_fee")) row.platform_fee = order.platform_fee;
    if (cols.has("delivery_address"))
      row.delivery_address = order.delivery_address;
    if (cols.has("note_for_restaurant"))
      row.note_for_restaurant = order.note_for_restaurant;
    if (cols.has("if_unavailable")) row.if_unavailable = order.if_unavailable;
    if (cols.has("status")) row.status = "CANCELLED";

    const r =
      String(reason || "").trim() ||
      String(order.status_reason || "").trim() ||
      "";
    if (cols.has("status_reason")) row.status_reason = r;
    if (cols.has("cancel_reason")) row.cancel_reason = r;
    if (cols.has("cancelled_reason")) row.cancelled_reason = r;
    if (cols.has("reason")) row.reason = r;

    if (cols.has("cancelled_by")) row.cancelled_by = cancelled_by;
    if (cols.has("cancelled_at")) row.cancelled_at = new Date();

    if (cols.has("created_at") && pick(row, "created_at") === undefined)
      row.created_at = new Date();
    if (cols.has("updated_at") && pick(row, "updated_at") === undefined)
      row.updated_at = new Date();

    if (Object.keys(row).length) {
      const fields = Object.keys(row);
      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((k) => row[k]);

      await conn.query(
        `INSERT IGNORE INTO cancelled_orders (${fields.join(", ")}) VALUES (${placeholders})`,
        values,
      );
    }
  }

  if (hasCancelledItems && items.length) {
    const cols = await getTableColumns("cancelled_order_items", conn);

    for (const it of items) {
      const row = {};
      if (cols.has("order_id")) row.order_id = it.order_id;
      if (cols.has("business_id")) row.business_id = it.business_id;
      if (cols.has("business_name")) row.business_name = it.business_name;
      if (cols.has("menu_id")) row.menu_id = it.menu_id;
      if (cols.has("item_name")) row.item_name = it.item_name;
      if (cols.has("item_image")) row.item_image = it.item_image;
      if (cols.has("quantity")) row.quantity = it.quantity;
      if (cols.has("price")) row.price = it.price;
      if (cols.has("subtotal")) row.subtotal = it.subtotal;

      if (cols.has("cancelled_by")) row.cancelled_by = cancelled_by;
      if (cols.has("reason")) row.reason = String(reason || "").trim() || null;
      if (cols.has("cancelled_at")) row.cancelled_at = new Date();

      if (cols.has("created_at") && pick(row, "created_at") === undefined)
        row.created_at = new Date();
      if (cols.has("updated_at") && pick(row, "updated_at") === undefined)
        row.updated_at = new Date();

      const fields = Object.keys(row);
      if (!fields.length) continue;

      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((k) => row[k]);

      await conn.query(
        `INSERT IGNORE INTO cancelled_order_items (${fields.join(", ")}) VALUES (${placeholders})`,
        values,
      );
    }
  }

  return { archived: true };
}

async function archiveDeliveredOrderInternal(
  conn,
  order_id,
  { delivered_by = "SYSTEM", reason = "" } = {},
) {
  const hasDeliveredOrders = await tableExists("delivered_orders", conn);
  const hasDeliveredItems = await tableExists("delivered_order_items", conn);
  if (!hasDeliveredOrders && !hasDeliveredItems) return { archived: false };

  const [[order]] = await conn.query(
    `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
    [order_id],
  );
  if (!order) return { archived: false };

  const [items] = await conn.query(
    `SELECT * FROM order_items WHERE order_id = ?`,
    [order_id],
  );

  const finalReason = String(reason || "").trim();

  let resolvedServiceType = null;
  try {
    resolvedServiceType = await resolveOrderServiceType(order_id, conn);
  } catch {
    resolvedServiceType = order.service_type
      ? String(order.service_type).trim().toUpperCase()
      : null;
  }
  if (resolvedServiceType !== "FOOD" && resolvedServiceType !== "MART")
    resolvedServiceType = "FOOD";

  const deliveredBy =
    String(delivered_by || "SYSTEM")
      .trim()
      .toUpperCase() || "SYSTEM";

  const firstPhotoFromList = (v) => {
    if (v == null) return null;
    if (Array.isArray(v)) return v.map(String).filter(Boolean)[0] || null;
    const s = String(v).trim();
    if (!s) return null;
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean)[0] || null;
      return s;
    } catch {
      return s;
    }
  };

  if (hasDeliveredOrders) {
    const cols = await getTableColumns("delivered_orders", conn);
    const row = {};

    if (cols.has("order_id")) row.order_id = order.order_id;
    if (cols.has("user_id")) row.user_id = order.user_id;
    if (cols.has("service_type")) row.service_type = resolvedServiceType;

    if (cols.has("status")) row.status = "DELIVERED";
    if (cols.has("status_reason"))
      row.status_reason =
        finalReason || String(order.status_reason || "").trim() || null;

    const delivery_fee = Number(order.delivery_fee || 0);
    const discount_amount = Number(order.discount_amount || 0);
    const platform_fee = Number(order.platform_fee || 0);
    const total_amount = Number(order.total_amount || 0);

    if (cols.has("delivery_fee")) row.delivery_fee = delivery_fee;
    if (cols.has("discount_amount")) row.discount_amount = discount_amount;
    if (cols.has("platform_fee")) row.platform_fee = platform_fee;
    if (cols.has("merchant_delivery_fee"))
      row.merchant_delivery_fee =
        order.merchant_delivery_fee != null
          ? Number(order.merchant_delivery_fee)
          : null;

    if (cols.has("total_amount")) row.total_amount = total_amount;

    if (cols.has("total_amount") && Number(row.total_amount || 0) === 0) {
      const items_total = (items || []).reduce(
        (s, it) => s + Number(it.subtotal || 0),
        0,
      );
      if (items_total > 0) {
        row.total_amount = Number(
          (items_total + delivery_fee - discount_amount + platform_fee).toFixed(
            2,
          ),
        );
      }
    }

    if (cols.has("payment_method"))
      row.payment_method = String(order.payment_method || "")
        .trim()
        .toUpperCase();

    if (cols.has("delivery_address"))
      row.delivery_address =
        order.delivery_address != null ? String(order.delivery_address) : "";

    if (cols.has("note_for_restaurant"))
      row.note_for_restaurant = order.note_for_restaurant ?? null;
    if (cols.has("if_unavailable"))
      row.if_unavailable = order.if_unavailable ?? null;
    if (cols.has("fulfillment_type"))
      row.fulfillment_type = order.fulfillment_type || "Delivery";
    if (cols.has("priority")) row.priority = !!order.priority;
    if (cols.has("estimated_arrivial_time"))
      row.estimated_arrivial_time = order.estimated_arrivial_time ?? null;

    if (cols.has("delivery_special_mode")) {
      row.delivery_special_mode = order.delivery_special_mode
        ? String(order.delivery_special_mode).trim().toUpperCase()
        : null;
    }

    if (cols.has("delivery_floor_unit"))
      row.delivery_floor_unit = order.delivery_floor_unit ?? null;
    if (cols.has("delivery_instruction_note"))
      row.delivery_instruction_note = order.delivery_instruction_note ?? null;

    if (cols.has("delivery_photo_url")) {
      const photo =
        order.delivery_photo_url && String(order.delivery_photo_url).trim()
          ? String(order.delivery_photo_url).trim()
          : firstPhotoFromList(order.delivery_photo_urls);
      row.delivery_photo_url = photo || null;
    }

    if (cols.has("delivered_by")) row.delivered_by = deliveredBy;
    if (cols.has("delivered_at")) row.delivered_at = new Date();

    if (cols.has("delivery_batch_id"))
      row.delivery_batch_id = order.delivery_batch_id ?? null;
    if (cols.has("delivery_driver_id"))
      row.delivery_driver_id = order.delivery_driver_id ?? null;
    if (cols.has("delivery_ride_id"))
      row.delivery_ride_id = order.delivery_ride_id ?? null;

    if (cols.has("delivery_status")) row.delivery_status = "DELIVERED";

    if (cols.has("original_created_at"))
      row.original_created_at = order.created_at ?? null;
    if (cols.has("original_updated_at"))
      row.original_updated_at = order.updated_at ?? null;

    const fields = Object.keys(row);
    if (fields.length) {
      const colSql = fields.map((f) => `\`${f}\``).join(", ");
      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((k) => row[k]);

      const updateFields = fields.filter((f) => f !== "order_id");
      const updateSql = updateFields.length
        ? updateFields.map((f) => `\`${f}\`=VALUES(\`${f}\`)`).join(", ")
        : "`order_id`=`order_id`";

      await conn.query(
        `INSERT INTO delivered_orders (${colSql})
         VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateSql}`,
        values,
      );
    }
  }

  if (hasDeliveredItems) {
    const cols = await getTableColumns("delivered_order_items", conn);

    await conn.query(`DELETE FROM delivered_order_items WHERE order_id = ?`, [
      order_id,
    ]);

    for (const it of items || []) {
      const row = {};
      if (cols.has("order_id")) row.order_id = it.order_id;
      if (cols.has("business_id")) row.business_id = it.business_id;
      if (cols.has("business_name"))
        row.business_name = it.business_name ?? null;

      if (cols.has("menu_id")) row.menu_id = it.menu_id;
      if (cols.has("item_name")) row.item_name = it.item_name ?? null;
      if (cols.has("item_image")) row.item_image = it.item_image ?? null;

      if (cols.has("quantity")) row.quantity = Number(it.quantity ?? 1);
      if (cols.has("price")) row.price = Number(it.price ?? 0);
      if (cols.has("subtotal")) row.subtotal = Number(it.subtotal ?? 0);

      if (cols.has("platform_fee"))
        row.platform_fee = Number(it.platform_fee ?? 0);
      if (cols.has("delivery_fee"))
        row.delivery_fee = Number(it.delivery_fee ?? 0);

      const fields = Object.keys(row);
      if (!fields.length) continue;

      const colSql = fields.map((f) => `\`${f}\``).join(", ");
      const placeholders = fields.map(() => "?").join(", ");
      const values = fields.map((k) => row[k]);

      await conn.query(
        `INSERT INTO delivered_order_items (${colSql}) VALUES (${placeholders})`,
        values,
      );
    }
  }

  return { archived: true };
}

async function deleteOrderFromMainTablesInternal(conn, order_id) {
  await conn.query(`DELETE FROM order_items WHERE order_id = ?`, [order_id]);
  await conn.query(`DELETE FROM orders WHERE order_id = ?`, [order_id]);
}

async function trimDeliveredOrdersForUser(conn, userId, keep = 10) {
  const hasDeliveredOrders = await tableExists("delivered_orders", conn);
  if (!hasDeliveredOrders) return { trimmed: 0 };

  const cols = await getTableColumns("delivered_orders", conn);
  const hasDeliveredId = cols.has("delivered_id");
  const hasDeliveredAt = cols.has("delivered_at");

  const orderBy = hasDeliveredAt
    ? `ORDER BY delivered_at DESC${hasDeliveredId ? ", delivered_id DESC" : ""}`
    : hasDeliveredId
      ? `ORDER BY delivered_id DESC`
      : `ORDER BY order_id DESC`;

  const [oldRows] = await conn.query(
    `
    SELECT order_id
      FROM delivered_orders
     WHERE user_id = ?
     ${orderBy}
     LIMIT ?, 100000
     FOR UPDATE
    `,
    [userId, keep],
  );

  if (!oldRows.length) return { trimmed: 0 };

  const oldIds = oldRows.map((r) => r.order_id);
  const [del] = await conn.query(
    `DELETE FROM delivered_orders WHERE user_id = ? AND order_id IN (?)`,
    [userId, oldIds],
  );

  return { trimmed: del.affectedRows || 0 };
}

/* ================= CANCEL + ARCHIVE + DELETE ================= */
async function cancelAndArchiveOrder(
  order_id,
  {
    cancelled_by = "SYSTEM",
    reason = "",
    cancel_reason = "",
    onlyIfStatus = null,
    expectedUserId = null,
  } = {},
) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT order_id, user_id, status FROM orders WHERE order_id = ? FOR UPDATE`,
      [order_id],
    );
    if (!row) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const user_id = Number(row.user_id);
    const current = String(row.status || "").toUpperCase();

    if (expectedUserId != null && Number(expectedUserId) !== user_id) {
      await conn.rollback();
      return { ok: false, code: "FORBIDDEN" };
    }

    if (onlyIfStatus && current !== String(onlyIfStatus).toUpperCase()) {
      await conn.rollback();
      return { ok: false, code: "SKIPPED", current_status: current };
    }

    const [bizRows] = await conn.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id],
    );
    const business_ids = bizRows.map((x) => x.business_id);

    const finalReason = String(reason || cancel_reason || "").trim();
    const hasReason = await ensureStatusReasonSupport();

    if (hasReason) {
      await conn.query(
        `UPDATE orders SET status='CANCELLED', status_reason=?, updated_at=NOW() WHERE order_id=?`,
        [finalReason, order_id],
      );
    } else {
      await conn.query(
        `UPDATE orders SET status='CANCELLED', updated_at=NOW() WHERE order_id=?`,
        [order_id],
      );
    }

    await archiveCancelledOrderInternal(conn, order_id, {
      cancelled_by,
      reason: finalReason,
    });
    await deleteOrderFromMainTablesInternal(conn, order_id);

    await conn.commit();
    return { ok: true, user_id, business_ids, status: "CANCELLED" };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

async function cancelIfStillPending(order_id, reason) {
  const out = await cancelAndArchiveOrder(order_id, {
    cancelled_by: "SYSTEM",
    reason,
    onlyIfStatus: "PENDING",
  });
  return !!out?.ok;
}

/* ================= DELIVERED: COMPLETE + CAPTURE(optional) + ARCHIVE + DELETE ================= */
async function completeAndArchiveDeliveredOrder(
  order_id,
  { delivered_by = "SYSTEM", reason = "", capture_at = "DELIVERED" } = {},
) {
  const CAPTURE_AT = String(capture_at ?? process.env.CAPTURE_AT ?? "DELIVERED")
    .trim()
    .toUpperCase();
  const CAPTURE_DISABLED = new Set(["SKIP", "NONE", "OFF", "DISABLED"]);

  // Prefetch ids only if capture enabled
  let prefetchedIds = [];
  if (!CAPTURE_DISABLED.has(CAPTURE_AT) && CAPTURE_AT === "DELIVERED") {
    try {
      const [[pre]] = await db.query(
        `SELECT payment_method FROM orders WHERE order_id = ? LIMIT 1`,
        [order_id],
      );
      const pm = pre?.payment_method
        ? String(pre.payment_method).trim().toUpperCase()
        : null;

      if (pm === "WALLET") prefetchedIds = await prefetchTxnIdsBatch(3);
      else if (pm === "COD") prefetchedIds = await prefetchTxnIdsBatch(2);
    } catch (e) {
      return {
        ok: false,
        code: "CAPTURE_FAILED",
        error: e?.message || "ID prefetch failed",
      };
    }
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT order_id, user_id, status, payment_method
         FROM orders
        WHERE order_id = ?
        FOR UPDATE`,
      [order_id],
    );
    if (!row) {
      await conn.rollback();
      return { ok: false, code: "NOT_FOUND" };
    }

    const user_id = Number(row.user_id);
    const current = String(row.status || "").toUpperCase();
    const payMethod = String(row.payment_method || "").toUpperCase();

    if (current === "CANCELLED") {
      await conn.rollback();
      return { ok: false, code: "SKIPPED", current_status: current };
    }

    const [bizRows] = await conn.query(
      `SELECT DISTINCT business_id FROM order_items WHERE order_id = ?`,
      [order_id],
    );
    const business_ids = bizRows
      .map((x) => Number(x.business_id))
      .filter((n) => Number.isFinite(n) && n > 0);

    const finalReason = String(reason || "").trim();

    const [[order]] = await conn.query(
      `SELECT * FROM orders WHERE order_id = ? LIMIT 1`,
      [order_id],
    );
    const [items] = await conn.query(
      `SELECT * FROM order_items WHERE order_id = ?`,
      [order_id],
    );

    // Capture (optional)
    let capture = { captured: false, skipped: true, payment_method: payMethod };
    if (!CAPTURE_DISABLED.has(CAPTURE_AT) && CAPTURE_AT === "DELIVERED") {
      try {
        if (payMethod === "WALLET") {
          capture = await captureOrderFundsWithConn(
            conn,
            order_id,
            prefetchedIds,
          );
        } else if (payMethod === "COD") {
          capture = await captureOrderCODFeeWithConn(
            conn,
            order_id,
            prefetchedIds,
          );
        }
      } catch (e) {
        await conn.rollback();
        return {
          ok: false,
          code: "CAPTURE_FAILED",
          error: e?.message || "Capture error",
        };
      }
    }

    // Ensure orders.status is DELIVERED
    const hasReason = await ensureStatusReasonSupport();
    if (hasReason) {
      await conn.query(
        `UPDATE orders
            SET status='DELIVERED', status_reason=?, updated_at=NOW()
          WHERE order_id=?`,
        [finalReason, order_id],
      );
    } else {
      await conn.query(
        `UPDATE orders
            SET status='DELIVERED', updated_at=NOW()
          WHERE order_id=?`,
        [order_id],
      );
    }

    // Ensure delivered_at and delivery_status if columns exist
    const extras = await ensureDeliveryExtrasSupport(conn);
    if (extras.hasDeliveredAt) {
      await conn.query(
        `UPDATE orders
            SET delivered_at = COALESCE(delivered_at, NOW())
          WHERE order_id = ?
          LIMIT 1`,
        [order_id],
      );
    }
    if (extras.hasDeliveryStatus) {
      await conn.query(
        `UPDATE orders
            SET delivery_status = 'DELIVERED'
          WHERE order_id = ?
          LIMIT 1`,
        [order_id],
      );
    }

    // Award points (non-fatal)
    let pointsInfo = null;
    try {
      pointsInfo = await awardPointsForCompletedOrderWithConn(conn, order_id);
    } catch (e) {
      pointsInfo = {
        awarded: false,
        reason: "points_error",
        error: e?.message,
      };
    }

    // merchant_earnings snapshot (safe + idempotent)
    // merchant_earnings snapshot (safe + idempotent)
    try {
      const deliveredAt = order?.delivered_at
        ? new Date(order.delivered_at)
        : new Date();

      const primaryBiz = items?.[0]?.business_id
        ? Number(items[0].business_id)
        : null;

      if (primaryBiz) {
        const totalAmount = Number(order?.total_amount || 0);
        const platformFeeTotal = Number(order?.platform_fee || 0);

        const USER_SHARE = Number(process.env.PLATFORM_USER_SHARE ?? 0.5);
        const safeUserShare =
          Number.isFinite(USER_SHARE) && USER_SHARE >= 0 && USER_SHARE <= 1
            ? USER_SHARE
            : 0.5;

        const platform_fee_user = Number(
          (platformFeeTotal * safeUserShare).toFixed(2),
        );

        const merchantEarningAmount = Number(
          (totalAmount - platform_fee_user).toFixed(2),
        );

        await insertMerchantEarningWithConn(conn, {
          business_id: primaryBiz,
          order_id,
          total_amount: merchantEarningAmount > 0 ? merchantEarningAmount : 0,
          dateObj: deliveredAt,
        });
      }
    } catch (e) {
      console.error("[merchant_earnings insert failed]", e?.message || e);
    }

    // food_mart_revenue snapshot (safe + idempotent)
    try {
      let ownerType = null;
      try {
        ownerType = await resolveOrderServiceType(order_id, conn);
      } catch {}
      ownerType = String(ownerType || "FOOD").toUpperCase();
      if (ownerType !== "FOOD" && ownerType !== "MART") ownerType = "FOOD";

      const deliveredAt = order?.delivered_at
        ? new Date(order.delivered_at)
        : new Date();

      const [[u]] = await conn.query(
        `SELECT user_name, phone FROM users WHERE user_id = ? LIMIT 1`,
        [user_id],
      );
      const customerName =
        (u?.user_name && String(u.user_name).trim()) || `User ${user_id}`;
      const customerPhone = u?.phone ? String(u.phone).trim() : null;

      const primaryBizId = items?.[0]?.business_id
        ? Number(items[0].business_id)
        : null;

      let businessName = null;
      if (primaryBizId) {
        const [[mbd]] = await conn.query(
          `SELECT business_name
             FROM merchant_business_details
            WHERE business_id = ?
            LIMIT 1`,
          [primaryBizId],
        );
        businessName =
          (mbd?.business_name && String(mbd.business_name).trim()) ||
          (items?.[0]?.business_name
            ? String(items[0].business_name).trim()
            : null) ||
          `Business ${primaryBizId}`;
      }

      const { summary, totalQty } = buildItemsSummary(items);

      const totalAmount = Number(order?.total_amount || 0);
      const platformFee = Number(order?.platform_fee || 0);

      const detailsObj = {
        order: {
          id: order_id,
          status: "DELIVERED",
          placed_at: deliveredAt,
          owner_type: ownerType,
          source: "delivered",
        },
        customer: { id: user_id, name: customerName, phone: customerPhone },
        business: {
          id: primaryBizId,
          name: businessName,
          owner_type: ownerType,
        },
        items: {
          summary: summary || "",
          total_quantity: Number(totalQty || 0),
        },
        amounts: {
          total_amount: totalAmount,
          platform_fee: platformFee,
          revenue_earned: platformFee,
          tax: 0,
        },
        payment: { method: payMethod },
      };

      if (primaryBizId) {
        await insertFoodMartRevenueWithConn(conn, {
          order_id,
          user_id,
          business_id: Number(primaryBizId),
          owner_type: ownerType,
          source: "delivered",
          status: "DELIVERED",
          placed_at: deliveredAt,
          payment_method: payMethod,
          total_amount: totalAmount,
          platform_fee: platformFee,
          revenue_earned: platformFee,
          tax: 0,
          customer_name: customerName,
          customer_phone: customerPhone,
          business_name: businessName,
          items_summary: summary || "",
          total_quantity: Number(totalQty || 0),
          details_json: JSON.stringify(detailsObj),
        });
      }
    } catch (e) {
      console.error("[food_mart_revenue insert failed]", e?.message);
    }

    // ✅ IMPORTANT: Enrich capture with amounts so notifications show correct Nu
    // Your controller expects:
    // - capture.order_amount
    // - capture.platform_fee_user
    // - capture.platform_fee_merchant
    // - capture.business_id
    // If capture already contains them, we keep them.
    try {
      const totalAmount = Number(order?.total_amount || 0);
      const platformFeeTotal = Number(order?.platform_fee || 0);

      // You can change shares if your system uses different split.
      const USER_SHARE = Number(process.env.PLATFORM_USER_SHARE ?? 0.5); // e.g. 0.5
      const safeUserShare =
        Number.isFinite(USER_SHARE) && USER_SHARE >= 0 && USER_SHARE <= 1
          ? USER_SHARE
          : 0.5;

      const platform_fee_user_raw = platformFeeTotal * safeUserShare;
      const platform_fee_user = Number(platform_fee_user_raw.toFixed(2));
      const platform_fee_merchant = Number(
        (platformFeeTotal - platform_fee_user).toFixed(2),
      );

      // Order amount transferred to merchant from user (so user debit splits cleanly)
      // total_amount = order_amount + platform_fee_user
      const order_amount = Number((totalAmount - platform_fee_user).toFixed(2));

      // Prefer item-derived business_id, fallback to first business_id list
      const primaryBizId =
        (items?.[0]?.business_id ? Number(items[0].business_id) : null) ||
        (business_ids?.[0] ? Number(business_ids[0]) : null) ||
        null;

      capture = {
        ...(capture || {}),
        // Always set these core identifiers
        order_id,
        user_id,
        payment_method: payMethod,

        // Only set/enrich amounts if they are missing
        business_id:
          capture?.business_id != null ? capture.business_id : primaryBizId,

        order_amount:
          capture?.order_amount != null
            ? Number(capture.order_amount)
            : order_amount,

        platform_fee_user:
          capture?.platform_fee_user != null
            ? Number(capture.platform_fee_user)
            : platform_fee_user,

        platform_fee_merchant:
          capture?.platform_fee_merchant != null
            ? Number(capture.platform_fee_merchant)
            : platform_fee_merchant,
      };
    } catch (e) {
      // Non-fatal: even if enrichment fails, delivery pipeline should still succeed
      console.error("[capture enrich failed]", e?.message || e);
      capture = {
        ...(capture || {}),
        order_id,
        user_id,
        payment_method: payMethod,
      };
    }

    await archiveDeliveredOrderInternal(conn, order_id, {
      delivered_by,
      reason: finalReason,
    });
    await deleteOrderFromMainTablesInternal(conn, order_id);
    await trimDeliveredOrdersForUser(conn, user_id, 10);

    await conn.commit();

    return {
      ok: true,
      user_id,
      business_ids,
      status: "DELIVERED",
      points: pointsInfo,
      capture: capture, // ✅ now includes amounts needed by controller notifications
    };
  } catch (e) {
    try {
      await conn.rollback();
    } catch {}
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  cancelAndArchiveOrder,
  cancelIfStillPending,
  completeAndArchiveDeliveredOrder,
};
