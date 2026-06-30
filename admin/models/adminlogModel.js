const { prisma } = require("../lib/prisma.js");

// Get all admin logs
async function getAll() {
  const logs = await prisma.admin_logs.findMany({
    select: {
      log_id: true,
      user_id: true,
      admin_name: true,
      activity: true,
      created_at: true,
    },
    orderBy: [
      {
        created_at: "desc",
      },
      {
        log_id: "desc",
      },
    ],
  });

  // Convert BigInt to Number for JSON serialization
  return logs.map((log) => ({
    log_id: Number(log.log_id),
    user_id: log.user_id ? Number(log.user_id) : null,
    admin_name: log.admin_name,
    activity: log.activity,
    created_at: log.created_at,
  }));
}

// Add a new admin log
async function addLog({ user_id = null, admin_name = "API", activity }) {
  if (!activity || !String(activity).trim()) return;

  let userId = user_id;

  // Ensure FK won't fail: if user_id not in users table -> set NULL
  if (userId !== null && userId !== undefined) {
    // Check if user exists
    const user = await prisma.users.findUnique({
      where: { user_id: Number(userId) },
      select: { user_id: true },
    });

    if (!user) {
      userId = null;
    }
  } else {
    userId = null;
  }

  // Create the log
  await prisma.admin_logs.create({
    data: {
      user_id: userId ? Number(userId) : null,
      admin_name: admin_name,
      activity: activity,
      created_at: new Date(),
    },
  });
}

module.exports = { getAll, addLog };
