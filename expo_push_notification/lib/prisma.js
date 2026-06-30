// driver/lib/prisma.js
const { PrismaMariaDb } = require("@prisma/adapter-mariadb");
const { PrismaClient } = require("../../generated/prisma");

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
