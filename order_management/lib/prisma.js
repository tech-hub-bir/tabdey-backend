// driver/lib/prisma.js
const dotenv = require("dotenv");
dotenv.config(); // Load env first

const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const { PrismaClient } = require("../../generated/prisma");

// Debug: Log the config being used
console.log("🔧 Prisma Config:");
console.log("  DB_HOST:", process.env.DB_HOST);
console.log("  DB_USER:", process.env.DB_USER);
console.log("  DB_NAME:", process.env.DB_NAME);
console.log(
  "  DB_PASSWORD:",
  process.env.DB_PASSWORD ? "✅ Set" : "❌ Not set",
);

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 10,
  connectTimeout: 60000,
  acquireTimeout: 60000,
  waitForConnections: true,
  queueLimit: 0,
});

const prisma = new PrismaClient({
  adapter,
  log: ["error", "warn"],
});

module.exports = { prisma };
