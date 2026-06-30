// src/models/rideTypeModel.js
import { withConn, qConn } from '../db/mysql.js';

/**
 * Get vehicle type from ride type name.
 * @param {string} serviceName - The service name (e.g., "Premium", "Taxi Reserved").
 * @returns {Promise<string|null>} - The vehicle type or null if not found.
 */
export const getVehicleTypeByServiceName = async (serviceName) => {
  if (!serviceName) return null;

  const sql = `
    SELECT vehicle_type
    FROM ride_types
    WHERE name = ?
    LIMIT 1
  `;

  return withConn(async (conn) => {
    const rows = await qConn(conn, sql, [serviceName]);
    return rows.length ? rows[0].vehicle_type : null;
  });
};