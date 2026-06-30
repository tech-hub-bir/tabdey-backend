// models/orders/crud/findByBusinessId.js
const { db } = require("../helpers");

module.exports = async function findByBusinessId(business_id) {
  const [items] = await db.query(
    `SELECT * FROM order_items WHERE business_id = ? ORDER BY order_id DESC, menu_id ASC`,
    [business_id],
  );
  return items;
};
