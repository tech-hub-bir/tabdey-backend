// models/userNotificationModel.js
// ✅ Full Prisma version
// ✅ No raw db.query()
// ✅ Matches your actual Prisma schema:
//    - model: notifications
//    - id: BigInt
//    - user_id: BigInt
//    - status enum: unread | read

const { prisma } = require("../lib/prisma");

/* ---------------- helpers ---------------- */

function toBigIntPositive(v, name) {
  const n = Number(v);

  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return BigInt(n);
}

function normalizeLimit(v) {
  return Math.min(Math.max(parseInt(v, 10) || 50, 1), 200);
}

function normalizeOffset(v) {
  return Math.max(parseInt(v, 10) || 0, 0);
}

function serializeValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeValue(value);
  }

  return out;
}

/* ---------------- model ---------------- */

const UserNotificationModel = {
  /**
   * List notifications for a user.
   *
   * @param {object} opts
   * @param {number|string} opts.user_id
   * @param {number|string} [opts.limit=50]
   * @param {number|string} [opts.offset=0]
   * @param {boolean} [opts.unreadOnly=false]
   */
  async listByUserId({ user_id, limit = 50, offset = 0, unreadOnly = false }) {
    const uid = toBigIntPositive(user_id, "user_id");

    const take = normalizeLimit(limit);
    const skip = normalizeOffset(offset);

    const rows = await prisma.notifications.findMany({
      where: {
        user_id: uid,
        ...(unreadOnly ? { status: "unread" } : {}),
      },
      select: {
        id: true,
        user_id: true,
        type: true,
        title: true,
        message: true,
        data: true,
        status: true,
        created_at: true,
      },
      orderBy: {
        created_at: "desc",
      },
      take,
      skip,
    });

    return rows.map(serializeRow);
  },

  /**
   * Get one notification by ID.
   */
  async getById(notification_id) {
    const id = toBigIntPositive(notification_id, "notification_id");

    const row = await prisma.notifications.findUnique({
      where: {
        id,
      },
      select: {
        id: true,
        user_id: true,
        type: true,
        title: true,
        message: true,
        data: true,
        status: true,
        created_at: true,
      },
    });

    return serializeRow(row) || null;
  },

  /**
   * Mark a single notification as read.
   *
   * Old SQL also updated created_at = NOW().
   * This keeps the same behavior.
   */
  async markAsRead(notification_id) {
    const id = toBigIntPositive(notification_id, "notification_id");

    const result = await prisma.notifications.updateMany({
      where: {
        id,
      },
      data: {
        status: "read",
        created_at: new Date(),
      },
    });

    return result.count || 0;
  },

  /**
   * Mark all unread notifications for a user as read.
   */
  async markAllAsRead(user_id) {
    const uid = toBigIntPositive(user_id, "user_id");

    const result = await prisma.notifications.updateMany({
      where: {
        user_id: uid,
        status: "unread",
      },
      data: {
        status: "read",
      },
    });

    return result.count || 0;
  },

  /**
   * Delete one notification by ID.
   */
  async deleteById(notification_id) {
    const id = toBigIntPositive(notification_id, "notification_id");

    const result = await prisma.notifications.deleteMany({
      where: {
        id,
      },
    });

    return result.count || 0;
  },
};

module.exports = UserNotificationModel;