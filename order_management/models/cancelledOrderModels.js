const { prisma } = require("../lib/prisma");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uniqStrings(arr) {
  return Array.from(
    new Set(
      (arr || [])
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

async function withRetry(fn, { retries = 2, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = e?.code;
      if (code === "P2034" || code === "P2028" || code?.includes("lock")) {
        await sleep(baseDelayMs * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Get cancelled orders for a specific user with pagination
 */
async function getCancelledOrdersByUser(user_id, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);

  // Fetch cancelled orders
  const orders = await prisma.cancelled_orders.findMany({
    where: { user_id: user_id },
    orderBy: { cancelled_at: "desc" },
    take: lim,
    skip: off,
    select: {
      cancelled_id: true,
      order_id: true,
      user_id: true,
      status: true,
      status_reason: true,
      total_amount: true,
      discount_amount: true,
      delivery_fee: true,
      platform_fee: true,
      merchant_delivery_fee: true,
      payment_method: true,
      delivery_address: true,
      note_for_restaurant: true,
      if_unavailable: true,
      fulfillment_type: true,
      priority: true,
      estimated_arrivial_time: true,
      cancelled_by: true,
      cancelled_at: true,
      original_created_at: true,
      original_updated_at: true,
    },
  });

  // Get total count
  const total = await prisma.cancelled_orders.count({
    where: { user_id: user_id },
  });

  if (!orders.length) {
    return { rows: [], total, limit: lim, offset: off };
  }

  const orderIds = orders.map((o) => o.order_id);

  // Fetch cancelled items for these orders
  const items = await prisma.cancelled_order_items.findMany({
    where: { order_id: { in: orderIds } },
    orderBy: { cancelled_item_id: "asc" },
    select: {
      order_id: true,
      business_id: true,
      business_name: true,
      menu_id: true,
      item_name: true,
      item_image: true,
      quantity: true,
      price: true,
      subtotal: true,
      created_at: true,
    },
  });

  // Group items by order
  const itemsByOrder = new Map();
  for (const it of items) {
    if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []);
    itemsByOrder.get(it.order_id).push(it);
  }

  // Collect all business_ids from items
  const businessIds = [...new Set(items.map((it) => Number(it.business_id)).filter((n) => n > 0))];

  // Map business_id -> service_type from merchant_business_details
  const serviceTypeByBusiness = new Map();

  if (businessIds.length) {
    const businesses = await prisma.merchant_business_details.findMany({
      where: { business_id: { in: businessIds } },
      select: { business_id: true, owner_type: true },
    });

    for (const biz of businesses) {
      const bid = Number(biz.business_id);
      const owner = String(biz.owner_type || "").trim().toUpperCase();
      
      let st = owner;
      if (owner === "MART" || owner === "FOOD") {
        st = owner;
      } else if (owner.includes("MART")) {
        st = "MART";
      } else if (owner.includes("FOOD") || owner.includes("RESTAUR")) {
        st = "FOOD";
      } else {
        st = owner || null;
      }
      serviceTypeByBusiness.set(bid, st);
    }
  }

  // Build output rows
  const rows = orders.map((o) => {
    const orderItems = itemsByOrder.get(o.order_id) || [];
    const firstBizId = orderItems.length ? Number(orderItems[0].business_id) : null;
    
    let service_type = firstBizId && serviceTypeByBusiness.has(firstBizId)
      ? serviceTypeByBusiness.get(firstBizId)
      : null;

    if (!service_type && orderItems.length) {
      for (const it of orderItems) {
        const bid = Number(it.business_id);
        if (serviceTypeByBusiness.has(bid)) {
          service_type = serviceTypeByBusiness.get(bid);
          break;
        }
      }
    }

    return {
      ...o,
      service_type: service_type || null,
      items: orderItems,
    };
  });

  return { rows, total, limit: lim, offset: off };
}

/**
 * Delete one cancelled order for a user (also deletes its cancelled items)
 */
async function deleteCancelledOrderByUser(user_id, order_id) {
  // Use transaction for atomic operation
  return await prisma.$transaction(async (tx) => {
    // Check if order exists and belongs to user
    const existingOrder = await tx.cancelled_orders.findFirst({
      where: { user_id: user_id, order_id: order_id },
      select: { order_id: true },
    });

    if (!existingOrder) {
      return { deleted: false };
    }

    // Delete items first (handle cascade)
    await tx.cancelled_order_items.deleteMany({
      where: { order_id: order_id },
    });

    // Delete the order
    const result = await tx.cancelled_orders.deleteMany({
      where: { user_id: user_id, order_id: order_id },
    });

    return { deleted: result.count > 0 };
  });
}

/**
 * Delete many cancelled orders for a user (also deletes items)
 */
async function deleteManyCancelledOrdersByUser(user_id, order_ids = []) {
  const ids = uniqStrings(order_ids);
  if (!ids.length) return { ok: false, code: "EMPTY_LIST" };

  const CHUNK = 200;
  let totalDeleted = 0;

  return await withRetry(async () => {
    return await prisma.$transaction(async (tx) => {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);

        // Find orders that exist for this user
        const existingOrders = await tx.cancelled_orders.findMany({
          where: { user_id: user_id, order_id: { in: chunk } },
          select: { order_id: true },
        });

        const foundIds = existingOrders.map((o) => o.order_id);
        if (!foundIds.length) continue;

        // Delete items for these orders
        await tx.cancelled_order_items.deleteMany({
          where: { order_id: { in: foundIds } },
        });

        // Delete the orders
        const result = await tx.cancelled_orders.deleteMany({
          where: { user_id: user_id, order_id: { in: foundIds } },
        });

        totalDeleted += result.count;
      }

      return { ok: true, deleted: totalDeleted };
    });
  });
}

module.exports = {
  getCancelledOrdersByUser,
  deleteCancelledOrderByUser,
  deleteManyCancelledOrdersByUser,
};