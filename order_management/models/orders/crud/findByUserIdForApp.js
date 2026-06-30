const {
  db,
  ensureStatusReasonSupport,
  ensureServiceTypeSupport,
  ensureDeliveryExtrasSupport,
  resolveOrderServiceType,
  parseDeliveryAddress,
} = require("../helpers");

module.exports = async function findByUserIdForApp(
  dbOrUserId,
  maybeUserIdOrServiceType = null,
  maybeServiceType = null,
) {
  const conn =
    dbOrUserId && typeof dbOrUserId.query === "function" ? dbOrUserId : db;

  const user_id =
    dbOrUserId && typeof dbOrUserId.query === "function"
      ? Number(maybeUserIdOrServiceType)
      : Number(dbOrUserId);

  const service_type =
    dbOrUserId && typeof dbOrUserId.query === "function"
      ? maybeServiceType
      : maybeUserIdOrServiceType;

  const hasReason = await ensureStatusReasonSupport();
  const hasService = await ensureServiceTypeSupport();
  const extras = await ensureDeliveryExtrasSupport();

  const params = [user_id];
  let serviceWhere = "";
  if (service_type && hasService) {
    serviceWhere = " AND o.service_type = ? ";
    params.push(service_type);
  }

  const [orders] = await conn.query(
    `
    SELECT
      o.order_id,
      o.user_id,
      ${hasService ? "o.service_type," : "NULL AS service_type,"}
      ${hasReason ? "o.status_reason," : "NULL AS status_reason,"}
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
      ${extras.hasPhotoList ? "o.delivery_photo_urls" : "NULL AS delivery_photo_urls"},

      o.delivery_batch_id,
      o.delivery_ride_id,
      o.delivery_driver_id,

      o.note_for_restaurant,
      o.if_unavailable,
      o.estimated_arrivial_time,
      o.status,
      o.fulfillment_type,
      o.priority,
      o.created_at,
      o.updated_at
    FROM orders o
    WHERE o.user_id = ?
    ${serviceWhere}
    ORDER BY o.created_at DESC
    `,
    params,
  );

  if (!orders.length) return [];

  const orderIds = orders.map((o) => o.order_id);

  const [items] = await conn.query(
    `
    SELECT
      order_id,
      business_id,
      business_name,
      menu_id,
      item_name,
      item_image,
      quantity,
      price,
      subtotal,
      platform_fee,
      delivery_fee
    FROM order_items
    WHERE order_id IN (?)
    ORDER BY order_id, business_id, menu_id
    `,
    [orderIds],
  );

  const itemsByOrder = new Map();
  const businessIdsSet = new Set();

  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);

    const bid = Number(it.business_id);
    if (Number.isFinite(bid) && bid > 0) businessIdsSet.add(bid);
  }

  const businessMap = new Map();
  const bizIds = Array.from(businessIdsSet);

  // In findByUserIdForApp.js, update the business query section:

  if (bizIds.length) {
    try {
      const [colsRows] = await conn.query(
        `
      SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'merchant_business_details'
      `,
      );
      const cols = new Set(colsRows.map((r) => String(r.COLUMN_NAME)));

      const addrCandidates = [
        "business_address",
        "address",
        "full_address",
        "location",
        "business_location",
        "business_addr",
      ].filter((c) => cols.has(c));

      const latCandidates = [
        "lat",
        "latitude",
        "business_lat",
        "delivery_lat",
      ].filter((c) => cols.has(c));

      const lngCandidates = [
        "lng",
        "longitude",
        "business_lng",
        "delivery_lng",
      ].filter((c) => cols.has(c));

      // ✅ ADD logo candidates
      const logoCandidates = [
        "business_logo",
        "logo",
        "logo_url",
        "business_logo_url",
        "image",
        "logo_path",
      ].filter((c) => cols.has(c));

      const addrExpr = addrCandidates.length
        ? `COALESCE(${addrCandidates.map((c) => `m.\`${c}\``).join(", ")})`
        : "NULL";

      const latExpr = latCandidates.length
        ? `m.\`${latCandidates[0]}\``
        : "NULL";
      const lngExpr = lngCandidates.length
        ? `m.\`${lngCandidates[0]}\``
        : "NULL";

      // ✅ ADD logo expression
      const logoExpr = logoCandidates.length
        ? `COALESCE(${logoCandidates.map((c) => `m.\`${c}\``).join(", ")})`
        : "NULL";

      const [bizRows] = await conn.query(
        `
      SELECT
        m.business_id,
        ${addrExpr} AS address,
        ${latExpr}  AS lat,
        ${lngExpr}  AS lng,
        ${logoExpr} AS business_logo
      FROM merchant_business_details m
      WHERE m.business_id IN (?)
      `,
        [bizIds],
      );

      for (const r of bizRows) {
        const bid = Number(r.business_id);
        if (!Number.isFinite(bid) || bid <= 0) continue;

        businessMap.set(bid, {
          address: r.address != null ? String(r.address).trim() : null,
          lat:
            r.lat != null && r.lat !== "" && !Number.isNaN(Number(r.lat))
              ? Number(r.lat)
              : null,
          lng:
            r.lng != null && r.lng !== "" && !Number.isNaN(Number(r.lng))
              ? Number(r.lng)
              : null,
          business_logo:
            r.business_logo != null ? String(r.business_logo).trim() : null, // ✅ ADD THIS
        });
      }
    } catch (e) {
      console.error("[findByUserIdForApp] business lookup failed:", e?.message);
    }
  }

  const parsePhotoList = (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map(String).filter(Boolean);
    const s = String(v).trim();
    if (!s) return [];
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
    } catch {
      return [s].filter(Boolean);
    }
  };

  const result = [];

  for (const o of orders) {
    const its = itemsByOrder.get(o.order_id) || [];
    const primaryBiz = its[0] || null;

    let st = o.service_type || null;
    if (!st) {
      try {
        st = await resolveOrderServiceType(o.order_id, conn);
      } catch {}
    }

    const deliverTo = parseDeliveryAddress(o.delivery_address) || {};

    if (deliverTo.lat == null && o.delivery_lat != null)
      deliverTo.lat = Number(o.delivery_lat);
    if (deliverTo.lng == null && o.delivery_lng != null)
      deliverTo.lng = Number(o.delivery_lng);

    deliverTo.delivery_floor_unit = o.delivery_floor_unit || null;
    deliverTo.delivery_instruction_note = o.delivery_instruction_note || null;
    deliverTo.delivery_special_mode = o.delivery_special_mode || null;

    const listFromCol = parsePhotoList(o.delivery_photo_urls);
    const legacy = o.delivery_photo_url
      ? String(o.delivery_photo_url).trim()
      : "";
    const merged = Array.from(
      new Set([...listFromCol, ...(legacy ? [legacy] : [])]),
    ).filter(Boolean);

    deliverTo.delivery_photo_urls = merged;
    deliverTo.delivery_photo_url = merged[0] || null;

    const bid = primaryBiz ? Number(primaryBiz.business_id) : null;
    const bizInfo = bid && businessMap.has(bid) ? businessMap.get(bid) : null;

    result.push({
      order_id: o.order_id,
      service_type: st || null,
      status: o.status,
      status_reason: o.status_reason || null,
      payment_method: o.payment_method,
      fulfillment_type: o.fulfillment_type,
      created_at: o.created_at,
      updated_at: o.updated_at,
      if_unavailable: o.if_unavailable || null,
      estimated_arrivial_time: o.estimated_arrivial_time || null,

      delivery_batch_id:
        o.delivery_batch_id != null ? o.delivery_batch_id : null,
      delivery_ride_id: o.delivery_ride_id != null ? o.delivery_ride_id : null,
      delivery_driver_id:
        o.delivery_driver_id != null ? o.delivery_driver_id : null,

      business_details: primaryBiz
        ? {
            business_id: primaryBiz.business_id,
            name: primaryBiz.business_name,
            address: bizInfo?.address ?? null,
            lat: bizInfo?.lat ?? null,
            lng: bizInfo?.lng ?? null,
            business_logo: bizInfo?.business_logo ?? null, // ✅ ADD THIS LINE
          }
        : null,

      deliver_to: deliverTo,

      totals: {
        items_subtotal: its.reduce((s, it) => s + Number(it.subtotal || 0), 0),
        delivery_fee: Number(o.delivery_fee || 0),
        merchant_delivery_fee:
          o.merchant_delivery_fee !== null
            ? Number(o.merchant_delivery_fee)
            : null,
        platform_fee: Number(o.platform_fee || 0),
        discount_amount: Number(o.discount_amount || 0),
        total_amount: Number(o.total_amount || 0),
      },

      items: its.map((it) => ({
        menu_id: it.menu_id,
        name: it.item_name,
        image: it.item_image,
        quantity: it.quantity,
        unit_price: it.price,
        line_subtotal: it.subtotal,
      })),
    });
  }

  return result;
};
