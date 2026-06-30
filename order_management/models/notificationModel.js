// models/notificationModel.js
const { prisma } = require("../lib/prisma");

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ---------------- helpers ---------------- */

function assertPositiveInt(n, name) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertUuid(id) {
  const value = String(id || "").trim();

  if (!UUID_RX.test(value)) {
    throw new Error("notification_id is invalid");
  }
}

function toLimit(v) {
  return Math.min(Math.max(parseInt(v, 10) || 50, 1), 200);
}

function toOffset(v) {
  return Math.max(parseInt(v, 10) || 0, 0);
}

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeNotification(row) {
  if (!row) return null;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

const notificationSelect = {
  notification_id: true,
  order_id: true,
  business_id: true,
  user_id: true,
  type: true,
  title: true,
  body_preview: true,
  is_read: true,
  created_at: true,
  delivered_at: true,
  seen_at: true,
};

const NotificationModel = {
  /**
   * List notifications for a business.
   * GET /api/order_notification/business/:businessId?limit=50&offset=0&unreadOnly=true
   */
  async listByBusinessId({
    business_id,
    limit = 50,
    offset = 0,
    unreadOnly = false,
  }) {
    business_id = Number(business_id);
    assertPositiveInt(business_id, "business_id");

    const lim = toLimit(limit);
    const off = toOffset(offset);

    const where = {
      business_id,
      ...(unreadOnly ? { is_read: false } : {}),
    };

    const rows = await prisma.order_notification.findMany({
      where,
      select: notificationSelect,
      orderBy: {
        created_at: "desc",
      },
      take: lim,
      skip: off,
    });

    return rows.map(serializeNotification);
  },

  /**
   * Get one notification by UUID.
   * GET /api/order_notification/:notificationId
   */
  async getById(notification_id) {
    notification_id = String(notification_id || "").trim();
    assertUuid(notification_id);

    const row = await prisma.order_notification.findUnique({
      where: {
        notification_id,
      },
      select: notificationSelect,
    });

    return serializeNotification(row);
  },

  /**
   * Mark one notification as read.
   * PATCH /api/order_notification/:notificationId/read
   */
  async markAsRead(notification_id) {
    notification_id = String(notification_id || "").trim();
    assertUuid(notification_id);

    const result = await prisma.order_notification.updateMany({
      where: {
        notification_id,
      },
      data: {
        is_read: true,
        seen_at: new Date(),
      },
    });

    return result.count;
  },

  /**
   * Mark all unread notifications for a business as read.
   * PATCH /api/order_notification/business/:businessId/read-all
   */
  async markAllAsRead(business_id) {
    business_id = Number(business_id);
    assertPositiveInt(business_id, "business_id");

    const result = await prisma.order_notification.updateMany({
      where: {
        business_id,
        is_read: false,
      },
      data: {
        is_read: true,
        seen_at: new Date(),
      },
    });

    return result.count;
  },

  /**
   * Delete one notification by UUID.
   * DELETE /api/order_notification/:notificationId
   */
  async deleteById(notification_id) {
    notification_id = String(notification_id || "").trim();
    assertUuid(notification_id);

    const result = await prisma.order_notification.deleteMany({
      where: {
        notification_id,
      },
    });

    return result.count;
  },
};

module.exports = NotificationModel;