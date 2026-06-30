// models/orders/crud/findAll.js
const {
  db,
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  parseDeliveryAddress,
} = require("../helpers");

module.exports = async function findAll() {
  const hasReason = await ensureStatusReasonSupport();
  const hasService = await ensureServiceTypeSupport();

  const [orders] = await db.query(
    `
    SELECT
      o.*,
      ${hasReason ? "o.status_reason" : "NULL AS status_reason"},
      ${hasService ? "o.service_type" : "NULL AS service_type"}
    FROM orders o
    ORDER BY o.created_at DESC
    `,
  );
  if (!orders.length) return [];

  const ids = orders.map((o) => o.order_id);
  const [items] = await db.query(
    `SELECT * FROM order_items WHERE order_id IN (?) ORDER BY order_id, business_id, menu_id`,
    [ids],
  );

  const byOrder = new Map();
  for (const o of orders) {
    o.items = [];
    o.delivery_address = parseDeliveryAddress(o.delivery_address);
    byOrder.set(o.order_id, o);
  }

  for (const it of items) byOrder.get(it.order_id)?.items.push(it);
  return orders;
};
