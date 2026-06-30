// driver/lib/prisma.js
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const { PrismaClient } = require("../../generated/prisma");

const adapter = new PrismaMariaDb({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  // TEMP LOAD-TEST TUNING (2026-06-22): raised from 10 to isolate whether
  // pool exhaustion (vs CPU) was the bottleneck under 1000 concurrent
  // registrations. Revisit this value (and the DB server's max_connections)
  // before production.
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 50),
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
