// src/config/mysql.js
const mysql = require("mysql2/promise");

const {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_CONN_LIMIT,
} = process.env;

if (!DB_HOST || !DB_USER || !DB_NAME) {
  console.warn(
    "[MySQL] Missing DB env vars. Check DB_HOST, DB_USER, DB_NAME, DB_PASSWORD."
  );
}

const pool = mysql.createPool({
  host: DB_HOST || "127.0.0.1",
  port: Number(DB_PORT || 3306),
  user: DB_USER || "root",
  password: DB_PASSWORD || "",
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(DB_CONN_LIMIT || 10),
  queueLimit: 0,
  charset: "utf8mb4_general_ci",
});

/**
 * Simple helper to run queries.
 * Usage:
 *   const rows = await query('SELECT * FROM rma_pg_logs WHERE order_no = ?', [orderNo]);
 */
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = {
  pool,
  query,
};
