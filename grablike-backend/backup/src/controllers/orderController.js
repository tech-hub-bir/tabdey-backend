// src/controllers/orderController.js
import { getPool } from "../config/mysql.js";
import { attachOrderToBatch, recomputeBatchStatus } from "../services/deliveryBatchService.js";
import { getPushTokensByUserIds } from "../services/getPushTokensByUserIds.js";
import { sendPushToTokens } from "../services/push.js";

/**
 * Create order for FOOD or MART.
 * Body example:
 * {
 *   service_type: "FOOD",    // or "MART"
 *   user_id: 123,
 *   business_id: 45,
 *   items: [
 *     { menu_id: 1, item_name: "Burger", item_image: "...", quantity: 2, price: 150 },
 *     ...
 *   ],
 *   total_amount: 300,
 *   discount_amount: 0,
 *   delivery_fee: 20,
 *   platform_fee: 10,
 *   merchant_delivery_fee: 10,
 *   delivery_address: "Thimphu ...",
 *   delivery_lat: 27.4723,
 *   delivery_lng: 89.6390,
 *   payment_method: "WALLET",
 *   status: "PENDING",   // your existing flow
 *   fulfillment_type: "DELIVERY",
 *   priority: 1
 * }
 */
export async function createOrder(req, res) {
  const pool = getPool();
  const conn = await pool.getConnection();

  try {
    const {
      service_type,
      user_id,
      business_id,
      items,
      total_amount,
      discount_amount,
      delivery_fee,
      platform_fee,
      merchant_delivery_fee,
      delivery_address,
      delivery_lat,
      delivery_lng,
      payment_method,
      status,
      fulfillment_type,
      priority,
      note_for_restaurant,
      if_unavailable,
    } = req.body;

    if (!user_id || !business_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: "Invalid payload" });
    }

    const svcType = service_type === "MART" ? "MART" : "FOOD";

    await conn.beginTransaction();

    // Generate your own string order_id (e.g. "ORD00000123")
    // or rely on some existing generator.
    const [idRes] = await conn.execute("SELECT UUID() AS id");
    const orderId = idRes[0].id.slice(0, 12); // example; replace by your own logic

    // 1) Insert into orders
    await conn.execute(
      `
      INSERT INTO orders
      (order_id, user_id, service_type, business_id,
       total_amount, discount_amount, delivery_fee,
       payment_method, delivery_address,
       note_for_restaurant, if_unavailable,
       status, status_reason,
       fulfillment_type, priority,
       platform_fee, merchant_delivery_fee,
       delivery_lat, delivery_lng,
       created_at, updated_at)
      VALUES
      (?, ?, ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?,
       ?, '',
       ?, ?,
       ?, ?,
       ?, ?,
       NOW(), NOW())
    `,
      [
        orderId,
        user_id,
        svcType,
        business_id,
        total_amount || 0,
        discount_amount || 0,
        delivery_fee || 0,
        payment_method || "COD",
        delivery_address || "",
        note_for_restaurant || "",
        if_unavailable || "",
        status || "PENDING",
        fulfillment_type || "DELIVERY",
        priority || 0,
        platform_fee || 0,
        merchant_delivery_fee || 0,
        delivery_lat ?? null,
        delivery_lng ?? null,
      ]
    );

    // 2) Insert items
    const itemValues = [];
    for (const it of items) {
      itemValues.push(
        orderId,
        business_id,
        null,               // batch_id will be set after attaching batch
        it.business_name || "",
        it.menu_id,
        it.item_name || "",
        it.item_image || "",
        it.quantity || 1,
        it.price || 0,
        (it.quantity || 1) * (it.price || 0),
        platform_fee || 0,
        delivery_fee || 0
      );
    }

    await conn.execute(
      `
      INSERT INTO order_items
        (order_id, business_id, batch_id,
         business_name, menu_id, item_name, item_image,
         quantity, price, subtotal,
         platform_fee, delivery_fee)
      VALUES
        ${items.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
    `,
      itemValues
    );

    await conn.commit();

    // 3) Attach to batch logic
    const batchId = await attachOrderToBatch(svcType, orderId);
    if (batchId) {
      await recomputeBatchStatus(batchId);
    }

    // Push to customer confirming order placement
    if (user_id) {
      getPushTokensByUserIds([user_id]).then((tokens) => {
        if (tokens.length) {
          sendPushToTokens(tokens, {
            title: "Order Placed",
            body: "Your order has been placed and is being prepared.",
            data: { type: "order_placed", order_id: orderId, batch_id: batchId },
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    return res.json({
      ok: true,
      order_id: orderId,
      batch_id: batchId,
      service_type: svcType,
      status: status || "PENDING",
    });
  } catch (err) {
    await conn.rollback();
    console.error("[createOrder] error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
}
