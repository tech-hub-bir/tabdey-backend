// test-db-config.js
require("dotenv").config();

console.log("Environment variables:");
console.log("DATABASE_URL:", process.env.DATABASE_URL);
console.log("DB_HOST:", process.env.DB_HOST);
console.log("DB_USER:", process.env.DB_USER);
console.log("DB_PASSWORD:", process.env.DB_PASSWORD ? "***SET***" : "NOT SET");
console.log("DB_NAME:", process.env.DB_NAME);

const mysql = require("mysql2/promise");

async function testConnection() {
  try {
    // Test with DATABASE_URL
    if (process.env.DATABASE_URL) {
      console.log("\nTesting with DATABASE_URL...");
      const conn1 = await mysql.createConnection(process.env.DATABASE_URL);
      console.log("✅ DATABASE_URL connection successful");
      await conn1.end();
    }

    // Test with individual params
    console.log("\nTesting with individual params...");
    const conn2 = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      user: process.env.DB_USER || "bidas",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME,
    });
    console.log("✅ Individual params connection successful");
    await conn2.end();
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
    if (error.code === "ER_ACCESS_DENIED_ERROR") {
      console.error("Access denied! Check username and password");
    }
  }
}

testConnection();
