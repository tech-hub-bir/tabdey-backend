// models/deliveredOrderModels.js
const { prisma } = require("../lib/prisma");

/* ---------------- helpers ---------------- */

function toValidUserId(user_id) {
  const uid = Number(user_id);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

function toValidLimit(limit) {
  return Math.min(Math.max(Number(limit) || 100, 1), 200);
}

function toValidOffset(offset) {
  return Math.max(Number(offset) || 0, 0);
}

function toValidOrderId(order_id) {
  const oid = String(order_id || "").trim();
  return oid || null;
}

function serializeBigInt(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function serializeRow(row) {
  if (!row) return row;

  const out = {};

  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") {
      out[key] = Number(value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

/* ---------------- get delivered orders by user ---------------- */

async function getDeliveredOrdersByUser(
  user_id,
  { limit = 100, offset = 0 } = {},
) {
  const uid = toValidUserId(user_id);
  const lim = toValidLimit(limit);
  const off = toValidOffset(offset);

  if (!uid) return [];

  const orders = await prisma.delivered_orders.findMany({
    where: {
      user_id: uid,
    },
    orderBy: {
      delivered_at: "desc",
    },
    take: lim,
    skip: off,
  });

  if (!orders.length) return [];

  const orderIds = orders.map((o) => o.order_id);

  const items = await prisma.delivered_order_items.findMany({
    where: {
      order_id: {
        in: orderIds,
      },
    },
    orderBy: [
      {
        order_id: "asc",
      },
      {
        business_id: "asc",
      },
      {
        menu_id: "asc",
      },
    ],
  });

  const itemsByOrder = new Map();

  for (const item of items) {
    const oid = item.order_id;

    if (!itemsByOrder.has(oid)) {
      itemsByOrder.set(oid, []);
    }

    itemsByOrder.get(oid).push(serializeRow(item));
  }

  return orders.map((order) => ({
    ...serializeRow(order),
    items: itemsByOrder.get(order.order_id) || [],
  }));
}

/* ---------------- delete one delivered order ---------------- */

async function deleteDeliveredOrderByUser(user_id, order_id) {
  const uid = toValidUserId(user_id);
  const oid = toValidOrderId(order_id);

  if (!uid || !oid) {
    return { deleted: 0 };
  }

  const existing = await prisma.delivered_orders.findFirst({
    where: {
      user_id: uid,
      order_id: oid,
    },
    select: {
      order_id: true,
    },
  });

  if (!existing) {
    return { deleted: 0 };
  }

  await prisma.delivered_orders.delete({
    where: {
      order_id: oid,
    },
  });

  return { deleted: 1 };
}

/* ---------------- delete many delivered orders ---------------- */

async function deleteManyDeliveredOrdersByUser(user_id, order_ids = []) {
  const uid = toValidUserId(user_id);

  const ids = Array.isArray(order_ids)
    ? order_ids.map((x) => String(x || "").trim()).filter(Boolean)
    : [];

  if (!uid || !ids.length) {
    return { deleted: 0 };
  }

  const result = await prisma.delivered_orders.deleteMany({
    where: {
      user_id: uid,
      order_id: {
        in: ids,
      },
    },
  });

  return {
    deleted: result.count || 0,
  };
}

module.exports = {
  getDeliveredOrdersByUser,
  deleteDeliveredOrderByUser,
  deleteManyDeliveredOrdersByUser,
};