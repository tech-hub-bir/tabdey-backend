// models/orders/crud/findByOrderIdGrouped.js
const {
  db,
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  resolveOrderServiceType,
  parseDeliveryAddress,
} = require("../helpers");

module.exports = async function findByOrderIdGrouped(order_id) {
  const hasReason = await ensureStatusReasonSupport();
  const hasService = await ensureServiceTypeSupport();

  const [orders] = await db.query(
    `
    SELECT
      o.order_id,
      o.user_id,
      u.user_name AS user_name,
      u.email     AS user_email,
      u.phone     AS user_phone,
      ${hasService ? "o.service_type," : "NULL AS service_type,"}
      ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
      o.total_amount,
      o.discount_amount,
      o.delivery_fee,
      o.platform_fee,
      o.merchant_delivery_fee,
      o.payment_method,
      o.delivery_address,
      o.note_for_restaurant,
      o.if_unavailable,
      o.estimated_arrivial_time,
      o.status,
      o.fulfillment_type,
      o.priority,
      o.created_at,
      o.updated_at
    FROM orders o
    LEFT JOIN users u ON u.user_id = o.user_id
    WHERE o.order_id = ?
    LIMIT 1
    `,
    [order_id],
  );
  if (!orders.length) return [];

  const [items] = await db.query(
    `SELECT * FROM order_items WHERE order_id = ? ORDER BY order_id, business_id, menu_id`,
    [order_id],
  );

  const o = orders[0];
  o.items = items;

  let resolvedServiceType = o.service_type || null;
  if (!resolvedServiceType) {
    try {
      resolvedServiceType = await resolveOrderServiceType(order_id, db);
    } catch {}
  }

  return [
    {
      user: {
        user_id: o.user_id,
        name: o.user_name || null,
        email: o.user_email || null,
        phone: o.user_phone || null,
      },
      orders: [
        {
          order_id: o.order_id,
          service_type: resolvedServiceType || null,
          status: o.status,
          status_reason: o.status_reason || null,
          total_amount: o.total_amount,
          discount_amount: o.discount_amount,
          delivery_fee: o.delivery_fee,
          platform_fee: o.platform_fee,
          merchant_delivery_fee: o.merchant_delivery_fee,
          payment_method: o.payment_method,
          delivery_address: parseDeliveryAddress(o.delivery_address),
          note_for_restaurant: o.note_for_restaurant,
          if_unavailable: o.if_unavailable || null,
          estimated_arrivial_time: o.estimated_arrivial_time || null,
          fulfillment_type: o.fulfillment_type,
          priority: o.priority,
          created_at: o.created_at,
          updated_at: o.updated_at,
          items: o.items,
        },
      ],
    },
  ];
};
