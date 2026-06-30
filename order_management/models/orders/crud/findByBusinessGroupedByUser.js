// models/orders/crud/findByBusinessGroupedByUser.js
const {
  db,
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  ensureDeliveryExtrasSupport,
  getOwnerTypeByBusinessId,
  parseDeliveryAddress,
} = require("../helpers");

module.exports = async function findByBusinessGroupedByUser(business_id) {
  const bid = Number(business_id);
  if (!Number.isFinite(bid) || bid <= 0) return [];

  const hasReason = await ensureStatusReasonSupport();
  const hasService = await ensureServiceTypeSupport();
  const extras = await ensureDeliveryExtrasSupport();

  const derivedServiceType = (await getOwnerTypeByBusinessId(bid, db)) || null;

  const [rows] = await db.query(
    `
    SELECT
      o.order_id,
      o.user_id,
      u.user_name,
      u.email,
      u.phone,

      ${hasService ? "o.service_type" : "NULL AS service_type"},
      o.status,
      ${hasReason ? "o.status_reason" : "NULL AS status_reason"},

      o.total_amount,
      o.discount_amount,
      o.delivery_fee,
      o.platform_fee,
      o.merchant_delivery_fee,
      o.payment_method,

      o.delivery_address,
      ${extras.hasLat ? "o.delivery_lat" : "NULL AS delivery_lat"},
      ${extras.hasLng ? "o.delivery_lng" : "NULL AS delivery_lng"},

      ${extras.hasFloor ? "o.delivery_floor_unit" : "NULL AS delivery_floor_unit"},
      ${extras.hasInstr ? "o.delivery_instruction_note" : "NULL AS delivery_instruction_note"},
      ${extras.hasMode ? "o.delivery_special_mode" : "NULL AS delivery_special_mode"},
      ${extras.hasPhoto ? "o.delivery_photo_url" : "NULL AS delivery_photo_url"},

      o.note_for_restaurant,
      o.if_unavailable,
      o.estimated_arrivial_time,
      o.fulfillment_type,
      o.priority,
      o.created_at,
      o.updated_at,

      oi.item_id,
      oi.business_id,
      oi.business_name,
      oi.menu_id,
      oi.item_name,
      oi.item_image,
      oi.quantity,
      oi.price,
      oi.subtotal,
      oi.platform_fee AS item_platform_fee,
      oi.delivery_fee AS item_delivery_fee

    FROM order_items oi
    INNER JOIN orders o ON o.order_id = oi.order_id
    LEFT JOIN users u ON u.user_id = o.user_id
    WHERE oi.business_id = ?
    ORDER BY o.created_at DESC, o.order_id DESC, oi.menu_id ASC
    `,
    [bid],
  );

  if (!rows.length) return [];

  const byUser = new Map();

  for (const r of rows) {
    const uid = Number(r.user_id);

    if (!byUser.has(uid)) {
      byUser.set(uid, {
        user: {
          user_id: uid,
          name: r.user_name || null,
          email: r.email || null,
          phone: r.phone || null,
        },
        orders: [],
        _ordersMap: new Map(),
      });
    }

    const group = byUser.get(uid);

    if (!group._ordersMap.has(r.order_id)) {
      let st = String(r.status || "").toUpperCase();
      if (st === "COMPLETED") st = "DELIVERED";

      const deliverTo = parseDeliveryAddress(r.delivery_address) || {};
      if (deliverTo.lat == null && r.delivery_lat != null)
        deliverTo.lat = Number(r.delivery_lat);
      if (deliverTo.lng == null && r.delivery_lng != null)
        deliverTo.lng = Number(r.delivery_lng);

      deliverTo.delivery_floor_unit = r.delivery_floor_unit || null;
      deliverTo.delivery_instruction_note = r.delivery_instruction_note || null;
      deliverTo.delivery_special_mode = r.delivery_special_mode || null;
      deliverTo.delivery_photo_url = r.delivery_photo_url || null;

      const orderObj = {
        order_id: r.order_id,
        service_type: r.service_type || derivedServiceType,
        status: st,
        status_reason: r.status_reason || null,

        // sum of item subtotals for THIS merchant within this order
        items_total: 0,

        payment_method: r.payment_method,
        fulfillment_type: r.fulfillment_type,
        priority: r.priority,
        estimated_arrivial_time: r.estimated_arrivial_time || null,

        note_for_restaurant: r.note_for_restaurant || null,
        if_unavailable: r.if_unavailable || null,

        deliver_to: deliverTo,

        totals: {
          total_amount: Number(r.total_amount || 0),
          discount_amount: Number(r.discount_amount || 0),
          delivery_fee: Number(r.delivery_fee || 0),
          platform_fee: Number(r.platform_fee || 0),
          merchant_delivery_fee:
            r.merchant_delivery_fee != null
              ? Number(r.merchant_delivery_fee)
              : null,
        },

        created_at: r.created_at,
        updated_at: r.updated_at,

        business: {
          business_id: r.business_id,
          business_name: r.business_name || null,
        },
        items: [],
      };

      group._ordersMap.set(r.order_id, orderObj);
      group.orders.push(orderObj);
    }

    const orderRef = group._ordersMap.get(r.order_id);

    const lineSubtotal = Number(r.subtotal || 0);
    orderRef.items_total = Number(
      (Number(orderRef.items_total || 0) + lineSubtotal).toFixed(2),
    );

    orderRef.items.push({
      item_id: r.item_id,
      business_id: r.business_id,
      business_name: r.business_name,
      menu_id: r.menu_id,
      item_name: r.item_name,
      item_image: r.item_image || null,
      quantity: r.quantity,
      price: r.price,
      subtotal: r.subtotal,
      platform_fee: Number(r.item_platform_fee || 0),
      delivery_fee: Number(r.item_delivery_fee || 0),
    });
  }

  const out = Array.from(byUser.values()).map((g) => {
    delete g._ordersMap;
    g.orders = (g.orders || []).map((o) => ({
      ...o,
      items_total: Number(Number(o.items_total || 0).toFixed(2)),
    }));
    return g;
  });

  return out;
};
