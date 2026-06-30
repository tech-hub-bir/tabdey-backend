// models/orders/crud/delete.js
const { db } = require("../helpers");

module.exports = async function del(order_id) {
  const [r] = await db.query(`DELETE FROM orders WHERE order_id = ?`, [
    order_id,
  ]);
  return r.affectedRows;
};
