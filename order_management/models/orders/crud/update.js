// models/orders/crud/update.js
const { db } = require("../helpers");

module.exports = async function update(order_id, orderData) {
  if (!orderData || !Object.keys(orderData).length) return 0;

  if (orderData.status) {
    let st = String(orderData.status).toUpperCase();
    if (st === "COMPLETED") st = "DELIVERED";
    orderData.status = st;
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "service_type")) {
    if (orderData.service_type != null) {
      const st = String(orderData.service_type || "").toUpperCase();
      if (!["FOOD", "MART"].includes(st))
        throw new Error("Invalid service_type (must be FOOD or MART)");
      orderData.service_type = st;
    }
  }

  if (Object.prototype.hasOwnProperty.call(orderData, "delivery_address")) {
    if (
      orderData.delivery_address &&
      typeof orderData.delivery_address === "object"
    ) {
      orderData.delivery_address = JSON.stringify(orderData.delivery_address);
    } else if (orderData.delivery_address == null) {
      orderData.delivery_address = null;
    } else {
      orderData.delivery_address = String(orderData.delivery_address);
    }
  }

  const fields = Object.keys(orderData);
  const values = Object.values(orderData);
  const setClause = fields.map((f) => `\`${f}\` = ?`).join(", ");

  const [result] = await db.query(
    `UPDATE orders SET ${setClause}, updated_at = NOW() WHERE order_id = ?`,
    [...values, order_id],
  );
  return result.affectedRows;
};
