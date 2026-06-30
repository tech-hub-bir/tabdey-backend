// models/orders/unavailableItemsProcessor.js
// Applies unavailable changes to order_items:
// - removed: delete rows for (business_id, menu_id)
// - replaced: delete old row, insert new row

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeRemoved(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((x) => ({
      business_id: toNum(x?.business_id),
      menu_id: toNum(x?.menu_id),
      item_name: x?.item_name ? String(x.item_name) : null,
    }))
    .filter((x) => x.business_id && x.menu_id);
}

function normalizeReplaced(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((r) => {
      const oldB = toNum(r?.old?.business_id);
      const oldM = toNum(r?.old?.menu_id);
      if (!oldB || !oldM) return null;

      const n = r?.new || {};
      const newB = toNum(n?.business_id);
      const newM = toNum(n?.menu_id);
      if (!newB || !newM) return null;

      const qty = toNum(n?.quantity) || 1;
      const price = toNum(n?.price) ?? 0;
      const subtotal = toNum(n?.subtotal) ?? qty * price;

      return {
        old: { business_id: oldB, menu_id: oldM },
        new: {
          business_id: newB,
          business_name: n?.business_name ? String(n.business_name) : null,
          menu_id: newM,
          item_name: n?.item_name ? String(n.item_name) : null,
          item_image: n?.item_image ? String(n.item_image) : null,
          quantity: qty,
          price,
          subtotal,
          delivery_fee: toNum(n?.delivery_fee) ?? 0,
        },
      };
    })
    .filter(Boolean);
}

async function applyUnavailableChanges(conn, order_id, unavailable_changes) {
  const uc =
    unavailable_changes && typeof unavailable_changes === "object"
      ? unavailable_changes
      : {};
  const removed = normalizeRemoved(uc.removed);
  const replaced = normalizeReplaced(uc.replaced);

  // REMOVE: delete matching items
  for (const x of removed) {
    await conn.query(
      `DELETE FROM order_items
        WHERE order_id = ?
          AND business_id = ?
          AND menu_id = ?
        LIMIT 1`,
      [order_id, x.business_id, x.menu_id],
    );
  }

  // REPLACE: remove old then insert new
  for (const r of replaced) {
    await conn.query(
      `DELETE FROM order_items
        WHERE order_id = ?
          AND business_id = ?
          AND menu_id = ?
        LIMIT 1`,
      [order_id, r.old.business_id, r.old.menu_id],
    );

    await conn.query(
      `INSERT INTO order_items
        (order_id, business_id, business_name, menu_id, item_name, item_image, quantity, price, subtotal, delivery_fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order_id,
        r.new.business_id,
        r.new.business_name,
        r.new.menu_id,
        r.new.item_name,
        r.new.item_image,
        r.new.quantity,
        r.new.price,
        r.new.subtotal,
        r.new.delivery_fee,
      ],
    );
  }

  return {
    removed_count: removed.length,
    replaced_count: replaced.length,
    hasAnyChanges: removed.length > 0 || replaced.length > 0,
  };
}

module.exports = { applyUnavailableChanges };
