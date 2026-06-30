// src/db/mysql.js
import { mysqlPool } from "../db/mysql.js";

/**
 * Get user IDs for a list of driver IDs.
 * @param {Array<number|string>} driverIds
 * @returns {Promise<number[]>}
 */
export async function getUserIdsByDriverIds(driverIds) {
  if (!driverIds.length) return [];

  const placeholders = driverIds.map(() => '?').join(',');
  const sql = `
    SELECT user_id
    FROM drivers
    WHERE driver_id IN (${placeholders})
  `;
  const [rows] = await mysqlPool.query(sql, driverIds);
  return rows.map(row => row.user_id);
}

/**
 * Get Expo push tokens for a list of user IDs.
 * @param {Array<number|string>} userIds
 * @returns {Promise<string[]>}
 */
export async function getPushTokensByUserIds(userIds) {
  if (!userIds.length) return [];

  const placeholders = userIds.map(() => '?').join(',');
  const sql = `
    SELECT device_id
    FROM all_device_ids
    WHERE user_id IN (${placeholders})
      AND device_id IS NOT NULL
      AND device_id != ''
  `;
  const [rows] = await mysqlPool.query(sql, userIds);
  return rows.map(row => row.device_id);
}

/**
 * Convenience: get push tokens directly from driver IDs.
 * @param {Array<number|string>} driverIds
 * @returns {Promise<string[]>}
 */
export async function getPushTokensByDriverIds(driverIds) {
  const userIds = await getUserIdsByDriverIds(driverIds);
  return getPushTokensByUserIds(userIds);
}