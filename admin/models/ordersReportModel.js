const { prisma } = require("../lib/prisma.js");

const REPORT_DEBUG =
  String(process.env.REPORT_DEBUG || "").toLowerCase() === "true";

function dlog(enabled, ...args) {
  if (enabled) console.log(...args);
}

function safeParseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  const s = String(v).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function round4(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 10000) / 10000;
}

/* ============================================================
   ORDERS REPORT - Fixed Version
   ============================================================ */

async function getUsers(userIds) {
  const users = await prisma.users.findMany({
    where: {
      user_id: { in: userIds },
    },
    select: {
      user_id: true,
      user_name: true,
    },
  });

  const map = {};
  users.forEach((u) => {
    map[Number(u.user_id)] = u.user_name;
  });
  return map;
}

async function fetchOrdersReportByOwnerType({
  ownerType,
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  limit = 100,
  offset = 0,
  debug = false,
}) {
  if (!ownerType) throw new Error("ownerType is required (food|mart)");
  const ownerTypeNorm = String(ownerType).toLowerCase().trim();
  if (!["food", "mart"].includes(ownerTypeNorm)) {
    throw new Error('ownerType must be "food" or "mart"');
  }

  const L = Math.min(Math.max(Number(limit), 1), 500);
  const O = Math.max(Number(offset), 0);
  const dbg = Boolean(debug) || REPORT_DEBUG;

  // Get merchant business IDs for the owner type
  const merchantWhere = { owner_type: ownerTypeNorm };
  if (businessIds.length) {
    merchantWhere.business_id = { in: businessIds };
  }

  const merchants = await prisma.merchant_business_details.findMany({
    where: merchantWhere,
    select: { business_id: true, business_name: true },
  });

  const merchantBusinessIds = merchants.map((m) => Number(m.business_id));
  const merchantNameMap = {};
  merchants.forEach((m) => {
    merchantNameMap[Number(m.business_id)] = m.business_name;
  });

  if (merchantBusinessIds.length === 0) {
    return [];
  }

  // Build where conditions for orders
  const orderWhere = {
    business_id: { in: merchantBusinessIds },
    ...(userId && { user_id: userId }),
    ...(dateFrom && { created_at: { gte: new Date(`${dateFrom} 00:00:00`) } }),
    ...(dateTo && { created_at: { lt: new Date(`${dateTo} 00:00:00`) } }),
  };

  if (status) {
    orderWhere.status = status;
  }

  // Fetch orders with their items
  const orders = await prisma.orders.findMany({
    where: orderWhere,
    include: {
      order_items: true,
    },
    orderBy: { created_at: "desc" },
  });

  // For cancelled orders, we need to filter by business_id through their items
  const cancelledWhere = {
    ...(userId && { user_id: userId }),
    ...(dateFrom && {
      cancelled_at: { gte: new Date(`${dateFrom} 00:00:00`) },
    }),
    ...(dateTo && { cancelled_at: { lt: new Date(`${dateTo} 00:00:00`) } }),
  };

  let cancelledOrders = await prisma.cancelled_orders.findMany({
    where: cancelledWhere,
    include: {
      cancelled_order_items: true,
    },
    orderBy: { cancelled_at: "desc" },
  });

  // Filter cancelled orders by business_id through their items
  if (merchantBusinessIds.length) {
    cancelledOrders = cancelledOrders.filter((order) =>
      order.cancelled_order_items.some((item) =>
        merchantBusinessIds.includes(Number(item.business_id)),
      ),
    );
  }

  // For delivered orders, filter by business_id through their items
  const deliveredWhere = {
    ...(userId && { user_id: userId }),
    ...(dateFrom && {
      delivered_at: { gte: new Date(`${dateFrom} 00:00:00`) },
    }),
    ...(dateTo && { delivered_at: { lt: new Date(`${dateTo} 00:00:00`) } }),
  };

  let deliveredOrders = await prisma.delivered_orders.findMany({
    where: deliveredWhere,
    include: {
      delivered_order_items: true,
    },
    orderBy: { delivered_at: "desc" },
  });

  // Filter delivered orders by business_id through their items
  if (merchantBusinessIds.length) {
    deliveredOrders = deliveredOrders.filter((order) =>
      order.delivered_order_items.some((item) =>
        merchantBusinessIds.includes(Number(item.business_id)),
      ),
    );
  }

  // Get user names
  const allUserIds = [
    ...new Set(
      [
        ...orders.map((o) => o.user_id),
        ...cancelledOrders.map((c) => c.user_id),
        ...deliveredOrders.map((d) => d.user_id),
      ].filter(Boolean),
    ),
  ];

  const userNames = await getUsers(allUserIds);

  // Process orders
  const processedOrders = orders.map((order) => {
    const items = order.order_items;
    const itemsByName = {};
    let totalQuantity = 0;

    items.forEach((item) => {
      itemsByName[item.item_name] =
        (itemsByName[item.item_name] || 0) + item.quantity;
      totalQuantity += item.quantity;
    });

    const itemsName = Object.entries(itemsByName)
      .map(([name, qty]) => `${name} x${qty}`)
      .join(", ");

    // Get business name from items or merchant map
    const businessName =
      items[0]?.business_name ||
      merchantNameMap[order.business_id] ||
      `Business ${order.business_id}`;

    return {
      Order_ID: order.order_id,
      Customer_Name: userNames[order.user_id] || `User ${order.user_id}`,
      Business_Name: businessName,
      Items_Name: itemsName,
      Total_Quantity: totalQuantity,
      Total_Amount: Number(order.total_amount || 0),
      Payment: order.payment_method,
      Status: order.status || "PENDING",
      Placed_At: order.created_at,
    };
  });

  // Process cancelled orders
  const processedCancelled = cancelledOrders.map((order) => {
    const items = order.cancelled_order_items;
    const itemsByName = {};
    let totalQuantity = 0;

    items.forEach((item) => {
      itemsByName[item.item_name] =
        (itemsByName[item.item_name] || 0) + item.quantity;
      totalQuantity += item.quantity;
    });

    const itemsName = Object.entries(itemsByName)
      .map(([name, qty]) => `${name} x${qty}`)
      .join(", ");

    const businessName =
      items[0]?.business_name ||
      `Business ${items[0]?.business_id || "Unknown"}`;

    return {
      Order_ID: order.order_id,
      Customer_Name: userNames[order.user_id] || `User ${order.user_id}`,
      Business_Name: businessName,
      Items_Name: itemsName,
      Total_Quantity: totalQuantity,
      Total_Amount: Number(order.total_amount || 0),
      Payment: order.payment_method,
      Status: "CANCELLED",
      Placed_At: order.cancelled_at,
    };
  });

  // Process delivered orders
  const processedDelivered = deliveredOrders.map((order) => {
    const items = order.delivered_order_items;
    const itemsByName = {};
    let totalQuantity = 0;

    items.forEach((item) => {
      itemsByName[item.item_name] =
        (itemsByName[item.item_name] || 0) + item.quantity;
      totalQuantity += item.quantity;
    });

    const itemsName = Object.entries(itemsByName)
      .map(([name, qty]) => `${name} x${qty}`)
      .join(", ");

    const businessName =
      items[0]?.business_name ||
      `Business ${items[0]?.business_id || "Unknown"}`;

    return {
      Order_ID: order.order_id,
      Customer_Name: userNames[order.user_id] || `User ${order.user_id}`,
      Business_Name: businessName,
      Items_Name: itemsName,
      Total_Quantity: totalQuantity,
      Total_Amount: Number(order.total_amount || 0),
      Payment: order.payment_method,
      Status: "DELIVERED",
      Placed_At: order.delivered_at,
    };
  });

  // Combine and sort
  const all = [
    ...processedOrders,
    ...processedCancelled,
    ...processedDelivered,
  ].sort((a, b) => {
    const ta = a.Placed_At ? new Date(a.Placed_At).getTime() : 0;
    const tb = b.Placed_At ? new Date(b.Placed_At).getTime() : 0;
    return tb - ta;
  });

  // Paginate
  const page = all.slice(O, O + L);

  return page;
}

/* ============================================================
   REVENUE REPORT
   ============================================================ */

async function fetchFoodMartRevenueReport({
  businessIds = [],
  userId,
  status,
  dateFrom,
  dateTo,
  debug = false,
}) {
  const dbg = Boolean(debug) || REPORT_DEBUG;

  // Build where conditions
  const where = {};

  if (businessIds.length) {
    where.business_id = { in: businessIds.map((id) => Number(id)) };
  }

  if (userId) {
    where.user_id = Number(userId);
  }

  if (status) {
    where.status = status;
  }

  if (dateFrom) {
    where.placed_at = { gte: new Date(`${dateFrom} 00:00:00`) };
  }

  if (dateTo) {
    where.placed_at = {
      ...where.placed_at,
      lt: new Date(`${dateTo} 00:00:00`),
    };
  }

  // Fetch revenue records
  const revenues = await prisma.food_mart_revenue.findMany({
    where,
    orderBy: { placed_at: "desc" },
  });

  return revenues.map((r) => {
    const totalAmount = Number(r.total_amount || 0);
    let details = safeParseJson(r.details_json);

    if (!details) {
      details = {
        order: {
          id: r.order_id,
          status: status || null,
          placed_at: r.placed_at || null,
          owner_type: r.owner_type || null,
          source: "food_mart_revenue",
        },
        amounts: {
          total_amount: totalAmount,
          platform_fee: 0,
          revenue_earned: 0,
          tax: 0,
        },
      };
    }

    if (!details.amounts || typeof details.amounts !== "object") {
      details.amounts = {};
    }

    const grossRevenueEarned = Number(r.revenue_earned || r.platform_fee || 0);
    const gstTax = round4(grossRevenueEarned * 0.05);
    const netPlatformFee = round4(grossRevenueEarned - gstTax);

    details.amounts.total_amount =
      Number(details.amounts.total_amount ?? totalAmount) || totalAmount;
    details.amounts.revenue_earned = round4(grossRevenueEarned);
    details.amounts.tax = gstTax;
    details.amounts.platform_fee = netPlatformFee;

    return {
      order_id: r.order_id,
      owner_type: r.owner_type ? r.owner_type.toUpperCase() : "",
      platform_fee: netPlatformFee,
      revenue_earned: round4(grossRevenueEarned),
      total_amount: totalAmount,
      details,
    };
  });
}

module.exports = {
  fetchOrdersReportByOwnerType,
  fetchFoodMartRevenueReport,
};
