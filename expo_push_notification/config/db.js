// ==============================
// db.js  (uses YOUR env names)
// ==============================
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "103.7.253.31",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "RootP@$$",
  database: process.env.DB_NAME || "Superapp_production",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  queueLimit: 0,
});

module.exports = pool;
