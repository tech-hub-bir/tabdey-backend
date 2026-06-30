// models/orders/crud/updateStatus.js
const { db, ensureStatusReasonSupport } = require("../helpers");

module.exports = async function updateStatus(order_id, status, reason) {
  const hasReason = await ensureStatusReasonSupport();

  let st = String(status).toUpperCase();
  if (st === "COMPLETED") st = "DELIVERED";

  if (hasReason) {
    const [r] = await db.query(
      `UPDATE orders SET status = ?, status_reason = ?, updated_at = NOW() WHERE order_id = ?`,
      [st, String(reason || "").trim(), order_id],
    );
    return r.affectedRows;
  }

  const [r] = await db.query(
    `UPDATE orders SET status = ?, updated_at = NOW() WHERE order_id = ?`,
    [st, order_id],
  );
  return r.affectedRows;
};
