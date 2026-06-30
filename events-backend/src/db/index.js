const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: [{ level: 'error', emit: 'event' }],
});

// Reconnect on connection loss
prisma.$on('error', async (e) => {
  console.error('[prisma] client error:', e.message);
  try {
    await prisma.$connect();
  } catch (err) {
    console.error('[prisma] reconnect failed:', err.message);
  }
});

// Warm up connection on startup
prisma.$connect().catch((err) => {
  console.error('[prisma] initial connect failed:', err.message);
});

module.exports = prisma;
