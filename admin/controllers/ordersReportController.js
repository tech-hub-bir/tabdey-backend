const { prisma } = require("../lib/prisma.js");
const Reports = require("../models/ordersReportModel");
const { addLog } = require("../models/adminlogModel");

async function requireAdmin(req) {
  const admin_user_id = req.user?.user_id;

  if (!admin_user_id) {
    const e = new Error("Authentication required");
    e.status = 401;
    throw e;
  }

  const actor = await prisma.users.findFirst({
    where: {
      user_id: Number(admin_user_id),
      role: {
        in: ["admin", "superadmin", "super admin", "finance"],
      },
    },
    select: {
      user_id: true,
      user_name: true,
      role: true,
    },
  });

  if (!actor) {
    const e = new Error("Forbidden: Admin or Super Admin required");
    e.status = 403;
    throw e;
  }

  return {
    user_id: Number(actor.user_id),
    admin_name: actor.user_name || "ADMIN",
    role: actor.role,
  };
}

function parseQuery(req) {
  const {
    business_id,
    business_ids,
    user_id,
    status,
    date_from,
    date_to,
    limit,
    offset,
  } = req.query;

  let businessIdList = [];
  if (business_ids) {
    businessIdList = String(business_ids)
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  if (business_id && Number.isFinite(Number(business_id))) {
    businessIdList.push(Number(business_id));
  }
  businessIdList = [...new Set(businessIdList)];

  return {
    businessIds: businessIdList,
    userId: user_id ? Number(user_id) : undefined,
    status: status ? String(status).toUpperCase() : undefined,
    dateFrom: date_from || undefined,
    dateTo: date_to || undefined,
    limit: limit ? Math.min(Math.max(Number(limit), 1), 500) : 100,
    offset: offset ? Math.max(Number(offset), 0) : 0,
  };
}

exports.getFoodOrdersReport = async (req, res) => {
  try {
    await requireAdmin(req);
    const args = parseQuery(req);
    const rows = await Reports.fetchOrdersReportByOwnerType({
      ...args,
      ownerType: "food",
    });
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error("[getFoodOrdersReport] Error:", err);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to fetch food orders report" });
  }
};

exports.getMartOrdersReport = async (req, res) => {
  try {
    await requireAdmin(req);
    const args = parseQuery(req);
    const rows = await Reports.fetchOrdersReportByOwnerType({
      ...args,
      ownerType: "mart",
    });
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error("[getMartOrdersReport] Error:", err);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to fetch mart orders report" });
  }
};

exports.getFoodMartRevenueReport = async (req, res) => {
  try {
    await requireAdmin(req);
    const args = parseQuery(req);
    const rows = await Reports.fetchFoodMartRevenueReport(args);
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error("[getFoodMartRevenueReport] Error:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to fetch food & mart revenue report",
    });
  }
};
