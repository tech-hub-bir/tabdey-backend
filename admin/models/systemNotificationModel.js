const { prisma } = require("../lib/prisma.js");

/**
 * Insert a new IN_APP system notification.
 * (We only store in DB when "in_app" channel is used.)
 */
async function insertSystemNotification(data) {
  const {
    title,
    message,
    deliveryChannels = [],
    targetAudience = [],
    createdBy = null,
  } = data;

  const status = "sent";
  const sentAt = new Date();

  const result = await prisma.system_notifications.create({
    data: {
      title: title,
      message: message,
      delivery_channels: JSON.stringify(deliveryChannels),
      target_audience: JSON.stringify(targetAudience),
      created_by: createdBy ? Number(createdBy) : null,
      sent_at: sentAt,
      status: status,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  return Number(result.id);
}

/**
 * Fetch all IN_APP notifications (for admin view).
 */
async function getAllSystemNotifications() {
  const rows = await prisma.system_notifications.findMany({
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
  });

  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    message: row.message,
    delivery_channels: row.delivery_channels,
    target_audience: row.target_audience,
    status: row.status,
    sent_at: row.sent_at,
    created_at: row.created_at,
  }));
}

/**
 * Fetch notifications visible to a user based on their role.
 * Only IN_APP notifications are stored here.
 */
async function getNotificationsForUserRole(userId) {
  if (!userId) return [];

  // Get user role
  const user = await prisma.users.findUnique({
    where: { user_id: Number(userId) },
    select: { role: true },
  });

  if (!user) return [];

  const role = user.role;

  // Fetch notifications that target this role
  const rows = await prisma.system_notifications.findMany({
    where: {
      status: "sent",
      target_audience: {
        contains: JSON.stringify(role),
      },
    },
    orderBy: {
      created_at: "desc",
    },
  });

  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    message: row.message,
    status: row.status,
    created_at: row.created_at,
  }));
}

/**
 * Fetch email + phone for a user_id (single user send)
 */
async function getUserContactById(userId) {
  if (!userId) return null;

  const user = await prisma.users.findUnique({
    where: { user_id: Number(userId) },
    select: {
      user_id: true,
      user_name: true,
      email: true,
      phone: true,
      role: true,
    },
  });

  if (!user) return null;

  return {
    user_id: Number(user.user_id),
    user_name: user.user_name,
    email: user.email,
    phone: user.phone,
    role: user.role,
  };
}

module.exports = {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,
  getUserContactById,
};
