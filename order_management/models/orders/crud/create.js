// models/orders/crud/create.js
const { db, generateOrderId, ensureServiceTypeSupport } = require("../helpers");

module.exports = async function create(orderData) {
  const order_id = String(orderData.order_id || generateOrderId())
    .trim()
    .toUpperCase();

  const [colsRows] = await db.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'`,
  );
  const cols = new Set(colsRows.map((r) => r.COLUMN_NAME));

  const hasService = await ensureServiceTypeSupport();

  let serviceType = null;
  if (hasService) {
    serviceType = String(orderData.service_type || "").toUpperCase();
    if (!serviceType || !["FOOD", "MART"].includes(serviceType)) {
      throw new Error("Invalid service_type (must be FOOD or MART)");
    }
  }

  const payload = {
    order_id,
    user_id: orderData.user_id,

    // ✅ ADDED: business_id from the first item (or null if no items)
    business_id: orderData.items?.[0]?.business_id || null,

    total_amount:
      orderData.total_amount != null ? Number(orderData.total_amount) : 0,
    discount_amount:
      orderData.discount_amount != null ? Number(orderData.discount_amount) : 0,
    delivery_fee:
      orderData.delivery_fee != null ? Number(orderData.delivery_fee) : 0,
    platform_fee:
      orderData.platform_fee != null ? Number(orderData.platform_fee) : 0,
    merchant_delivery_fee:
      orderData.merchant_delivery_fee != null
        ? Number(orderData.merchant_delivery_fee)
        : null,

    payment_method: String(orderData.payment_method || "").trim(),
    delivery_address:
      orderData.delivery_address &&
      typeof orderData.delivery_address === "object"
        ? JSON.stringify(orderData.delivery_address)
        : orderData.delivery_address,

    note_for_restaurant: orderData.note_for_restaurant || null,
    if_unavailable:
      orderData.if_unavailable !== undefined &&
      orderData.if_unavailable !== null
        ? String(orderData.if_unavailable)
        : null,

    status: (orderData.status || "PENDING").toUpperCase(),
    fulfillment_type: orderData.fulfillment_type || "Delivery",
    priority: !!orderData.priority,
  };

  if (hasService) payload.service_type = serviceType;

  if (cols.has("delivery_floor_unit"))
    payload.delivery_floor_unit = orderData.delivery_floor_unit || null;
  if (cols.has("delivery_instruction_note"))
    payload.delivery_instruction_note =
      orderData.delivery_instruction_note || null;
  if (cols.has("delivery_photo_url"))
    payload.delivery_photo_url = orderData.delivery_photo_url || null;

  if (cols.has("delivery_photo_urls")) {
    const arr = Array.isArray(orderData.delivery_photo_urls)
      ? orderData.delivery_photo_urls
          .map((x) => (x == null ? "" : String(x).trim()))
          .filter(Boolean)
      : [];
    payload.delivery_photo_urls = arr.length ? JSON.stringify(arr) : null;
  }

  if (cols.has("delivery_special_mode"))
    payload.delivery_special_mode = orderData.delivery_special_mode || null;

  if (cols.has("special_mode"))
    payload.special_mode =
      orderData.delivery_special_mode || orderData.special_mode || null;

  if (cols.has("delivery_status")) {
    payload.delivery_status = String(
      orderData.delivery_status || "PENDING",
    ).toUpperCase();
  }

  await db.query(`INSERT INTO orders SET ?`, payload);

  for (const item of orderData.items || []) {
    await db.query(`INSERT INTO order_items SET ?`, {
      order_id,
      business_id: item.business_id,
      business_name: item.business_name,
      menu_id: item.menu_id,
      item_name: item.item_name,
      item_image: item.item_image || null,
      quantity: item.quantity,
      price: item.price,
      subtotal: item.subtotal,
      platform_fee: 0,
      delivery_fee: 0,
    });
  }

  return order_id;
};
