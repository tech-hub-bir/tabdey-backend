// config/db.js
const mysql = require("mysql2/promise");
require("dotenv").config();

/**
 * Promise-based pool.
 * - dateStrings: true  → MySQL TIMESTAMP/DATETIME come back as strings (no UTC 'Z')
 * - timezone: '+06:00' → mysql2 interprets times in Bhutan time
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  dateStrings: true, // <- critical to avoid ISO 'Z' in JSON
  timezone: "+06:00", // <- Asia/Thimphu

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/**
 * Call once on startup to ensure session timezone on the server side.
 * Do NOT use pool.on('connection') — it can hand you non-promise conns.
 */
async function configureSessionTimezone() {
  try {
    await pool.query("SET time_zone = '+06:00'");
    const [r] = await pool.query("SELECT @@session.time_zone AS tz");
    console.log("✅ MySQL session time_zone:", r[0].tz);
  } catch (e) {
    console.error("⚠️ Failed to set session time_zone:", e.message);
  }
}

pool.configureSessionTimezone = configureSessionTimezone;

module.exports = pool;
