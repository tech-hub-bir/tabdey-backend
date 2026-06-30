// models/orders/crud/updateStatusWithUnavailable.js
const db = require("../../../config/db");

// ---- ETA formatting ----
function formatEtaRangeBhutan(estimated_minutes) {
  const mins = Number(estimated_minutes);
  if (!Number.isFinite(mins) || mins <= 0) return null;

  const now = new Date();
  const startDate = new Date(now.getTime() + mins * 60 * 1000);
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);

  const BHUTAN_OFFSET_HOURS = 6;

  const toBhutanParts = (d) => {
    const hour24 = (d.getUTCHours() + BHUTAN_OFFSET_HOURS) % 24;
    const minute = d.getUTCMinutes();
    const meridiem = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    return { hour12, minute, meridiem };
  };

  const s = toBhutanParts(startDate);
  const e = toBhutanParts(endDate);

  const sStr = `${s.hour12}:${String(s.minute).padStart(2, "0")}`;
  const eStr = `${e.hour12}:${String(e.minute).padStart(2, "0")}`;

  return s.meridiem === e.meridiem
    ? `${sStr} - ${eStr} ${s.meridiem}`
    : `${sStr} ${s.meridiem} - ${eStr} ${e.meridiem}`;
}

// ---- helpers ----
const n2 = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? Number(v.toFixed(2)) : null;
};

function normChanges(changes) {
  const uc = changes && typeof changes === "object" ? changes : {};

  const removed = Array.isArray(uc.removed) ? uc.removed : [];
  const replaced = Array.isArray(uc.replaced) ? uc.replaced : [];

  const removed_norm = removed
    .map((x) => ({
      business_id: Number(x?.business_id),
      menu_id: Number(x?.menu_id),
      item_name: x?.item_name ? String(x.item_name) : null,
    }))
    .filter(
      (x) =>
        Number.isFinite(x.business_id) &&
        x.business_id > 0 &&
        Number.isFinite(x.menu_id) &&
        x.menu_id > 0,
    );

  const replaced_norm = replaced
    .map((r) => {
      const oldB = Number(r?.old?.business_id);
      const oldM = Number(r?.old?.menu_id);

      if (
        !Number.isFinite(oldB) ||
        oldB <= 0 ||
        !Number.isFinite(oldM) ||
        oldM <= 0
      ) {
        return null;
      }

      const n = r?.new || {};

      const newB = Number(n?.business_id);
      const newM = Number(n?.menu_id);

      if (
        !Number.isFinite(newB) ||
        newB <= 0 ||
        !Number.isFinite(newM) ||
        newM <= 0
      ) {
        return null;
      }

      const quantity = Number(n?.quantity);
      const price = Number(n?.price);
      const subtotal = Number(n?.subtotal);

      const safeQty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
      const safePrice = Number.isFinite(price) && price >= 0 ? price : 0;
      const safeSubtotal =
        Number.isFinite(subtotal) && subtotal >= 0
          ? subtotal
          : safeQty * safePrice;

      return {
        old: {
          business_id: oldB,
          menu_id: oldM,
          item_name: r?.old?.item_name ? String(r.old.item_name) : null,
        },
        new: {
          business_id: newB,
          business_name: n?.business_name ? String(n.business_name) : null,
          menu_id: newM,
          item_name: n?.item_name ? String(n.item_name) : null,
          item_image: n?.item_image ? String(n.item_image) : null,
          quantity: safeQty,
          price: safePrice,
          subtotal: safeSubtotal,
        },
      };
    })
    .filter(Boolean);

  return { removed_norm, replaced_norm };
}

/**
 * Works for:
 * 1. Direct accept
 * 2. Remove item and accept
 * 3. Replace item and accept
 *
 * Model used:
 * orders.total_amount = gross payable
 * total_amount = items subtotal + delivery_fee - discount_amount + full platform_fee
 */
module.exports = async function updateStatusWithUnavailable(
  order_id,
  payload = {},
  externalConn = null,
) {
  const oid = String(order_id || "")
    .trim()
    .toUpperCase();
  if (!oid) return { ok: false, code: "BAD_ORDER_ID" };

  const status = String(payload.status || "")
    .trim()
    .toUpperCase();
  if (status !== "CONFIRMED") {
    return { ok: false, code: "ONLY_CONFIRMED_SUPPORTED" };
  }

  const reason = String(payload.reason || "").trim();

  const final_platform_fee = n2(payload.final_platform_fee);
  const final_discount_amount = n2(payload.final_discount_amount);
  const final_delivery_fee = n2(payload.final_delivery_fee);
  const final_merchant_delivery_fee = n2(payload.final_merchant_delivery_fee);

  const etaStr =
    payload.estimated_minutes != null
      ? formatEtaRangeBhutan(payload.estimated_minutes)
      : null;

  const { removed_norm, replaced_norm } = normChanges(
    payload.unavailable_changes,
  );

  const conn = externalConn || (await db.getConnection());
  const ownTransaction = !externalConn;

  try {
    if (ownTransaction) {
      await conn.beginTransaction();
    }
    const [[orderRow]] = await conn.query(
      `SELECT
          order_id,
          status,
          total_amount,
          platform_fee,
          discount_amount,
          delivery_fee,
          merchant_delivery_fee
         FROM orders
        WHERE order_id = ?
        FOR UPDATE`,
      [oid],
    );

    if (!orderRow) {
      if (ownTransaction) {
        await conn.rollback();
      }
      return { ok: false, code: "NOT_FOUND" };
    }

    const currentStatus = String(orderRow.status || "").toUpperCase();
    if (["DELIVERED", "CANCELLED"].includes(currentStatus)) {
      if (ownTransaction) {
        await conn.rollback();
      }
      return {
        ok: false,
        code: "LOCKED_STATUS",
        current_status: currentStatus,
      };
    }

    // 1. Remove unavailable items
    for (const rm of removed_norm) {
      await conn.query(
        `DELETE FROM order_items
          WHERE order_id = ?
            AND business_id = ?
            AND menu_id = ?`,
        [oid, rm.business_id, rm.menu_id],
      );
    }

    // 2. Replace unavailable items
    for (const rep of replaced_norm) {
      const n = rep.new;

      const [upd] = await conn.query(
        `UPDATE order_items
            SET business_id = ?,
                business_name = ?,
                menu_id = ?,
                item_name = ?,
                item_image = ?,
                quantity = ?,
                price = ?,
                subtotal = ?
          WHERE order_id = ?
            AND business_id = ?
            AND menu_id = ?
          LIMIT 1`,
        [
          n.business_id,
          n.business_name,
          n.menu_id,
          n.item_name,
          n.item_image,
          n.quantity,
          n.price,
          n.subtotal,
          oid,
          rep.old.business_id,
          rep.old.menu_id,
        ],
      );

      // Fallback insert if old row was not found
      if (!upd?.affectedRows) {
        await conn.query(
          `INSERT INTO order_items
            (order_id, business_id, business_name, menu_id, item_name, item_image, quantity, price, subtotal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            oid,
            n.business_id,
            n.business_name,
            n.menu_id,
            n.item_name,
            n.item_image,
            n.quantity,
            n.price,
            n.subtotal,
          ],
        );
      }
    }

    // 3. Recalculate items total after direct/remove/replace
    const [[sumRow]] = await conn.query(
      `SELECT COALESCE(SUM(subtotal), 0) AS items_total
         FROM order_items
        WHERE order_id = ?`,
      [oid],
    );

    const items_total = n2(sumRow?.items_total || 0);

    if (!(items_total > 0)) {
      if (ownTransaction) {
        await conn.rollback();
      }
      return {
        ok: false,
        code: "NO_ITEMS_AFTER_UPDATE",
        message: "Order cannot be confirmed because no valid items remain.",
      };
    }

    // If final values are not sent, preserve existing DB values.
    // This is what makes direct accept safe.
    const effective_platform_fee =
      final_platform_fee != null
        ? final_platform_fee
        : n2(orderRow.platform_fee || 0);

    const effective_discount_amount =
      final_discount_amount != null
        ? final_discount_amount
        : n2(orderRow.discount_amount || 0);

    const effective_delivery_fee =
      final_delivery_fee != null
        ? final_delivery_fee
        : n2(orderRow.delivery_fee || 0);

    const effective_merchant_delivery_fee =
      final_merchant_delivery_fee != null
        ? final_merchant_delivery_fee
        : n2(orderRow.merchant_delivery_fee || 0);

    // Gross payable model:
    // total = items + delivery - discount + full platform fee
    const effective_total_amount = n2(
      items_total +
        Number(effective_delivery_fee || 0) -
        Number(effective_discount_amount || 0) +
        Number(effective_platform_fee || 0),
    );

    if (!(effective_total_amount > 0)) {
      if (ownTransaction) {
        await conn.rollback();
      }
      return {
        ok: false,
        code: "INVALID_TOTAL_AMOUNT",
      };
    }

    // Optional: keep order.business_id aligned with the first remaining item
    const [[firstItem]] = await conn.query(
      `SELECT business_id
         FROM order_items
        WHERE order_id = ?
        ORDER BY menu_id ASC
        LIMIT 1`,
      [oid],
    );

    const effective_business_id =
      firstItem?.business_id != null ? Number(firstItem.business_id) : null;

    if (Number.isFinite(effective_business_id) && effective_business_id > 0) {
      await conn.query(
        `UPDATE orders
            SET business_id = ?
          WHERE order_id = ?`,
        [effective_business_id, oid],
      );
    }

    await conn.query(
      `UPDATE orders
          SET status = 'CONFIRMED',
              status_reason = ?,
              total_amount = ?,
              platform_fee = ?,
              discount_amount = ?,
              delivery_fee = ?,
              merchant_delivery_fee = ?,
              estimated_arrivial_time = COALESCE(?, estimated_arrivial_time),
              updated_at = NOW()
        WHERE order_id = ?`,
      [
        reason || null,
        effective_total_amount,
        effective_platform_fee,
        effective_discount_amount,
        effective_delivery_fee,
        effective_merchant_delivery_fee,
        etaStr,
        oid,
      ],
    );

if (ownTransaction) {
  await conn.commit();
}
    return {
      ok: true,
      order_id: oid,
      status: "CONFIRMED",
      estimated_arrivial_time: etaStr,

      items_total,
      effective_total_amount,
      effective_platform_fee,
      effective_discount_amount,
      effective_delivery_fee,
      effective_merchant_delivery_fee,

      applied: {
        removed_count: removed_norm.length,
        replaced_count: replaced_norm.length,
      },
    };
  } catch (e) {
    try {
      if (ownTransaction) {
        await conn.rollback();
      }
    } catch {}

    return {
      ok: false,
      code: "DB_ERROR",
      error: e?.message || String(e),
    };
  } finally {
if (ownTransaction) {
  conn.release();
}  }
};
