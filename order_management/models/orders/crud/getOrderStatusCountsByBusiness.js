// models/orders/crud/getOrderStatusCountsByBusiness.js
const { db } = require("../helpers");

module.exports = async function getOrderStatusCountsByBusiness(business_id) {
  const [rows] = await db.query(
    `
    SELECT o.status, COUNT(DISTINCT o.order_id) AS count
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.order_id
     WHERE oi.business_id = ?
     GROUP BY o.status
    `,
    [business_id],
  );

  const allStatuses = [
    "PENDING",
    "CONFIRMED",
    "PREPARING",
    "READY",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "CANCELLED",
    "REJECTED",
    "DECLINED",
  ];

  const result = {};
  for (const s of allStatuses) result[s] = 0;

  for (const row of rows) {
    let key = String(row.status || "").toUpperCase();
    if (key === "COMPLETED") key = "DELIVERED";
    if (key) result[key] = Number(row.count) || 0;
  }

  const [todayRows] = await db.query(
    `
    SELECT COUNT(DISTINCT o.order_id) AS declined_today
      FROM orders o
      INNER JOIN order_items oi ON oi.order_id = o.order_id
     WHERE oi.business_id = ?
       AND o.status = 'DECLINED'
       AND DATE(o.created_at) = CURDATE()
    `,
    [business_id],
  );

  result.order_declined_today = Number(todayRows[0]?.declined_today || 0);
  return result;
};
