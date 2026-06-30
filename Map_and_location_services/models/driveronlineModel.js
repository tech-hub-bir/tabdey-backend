// models/driverSqlModel.js
const pool = require("../config/db");

/**
 * Set a driver's online status in MySQL by user_id.
 * @param {number|string} user_id
 * @param {boolean|number} isOnline - truthy => 1, falsy => 0
 * @returns {number} affectedRows
 */
async function setDriverOnlineStatusByUserId(user_id, isOnline) {
  const sql = `UPDATE drivers SET is_online = ? WHERE user_id = ?`;
  const [res] = await pool.query(sql, [isOnline ? 1 : 0, user_id]);
  return res.affectedRows;
}

module.exports = { setDriverOnlineStatusByUserId };
