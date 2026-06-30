const { prisma } = require("../lib/prisma");

function n2(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function getBhutanTodayDateString() {
  const now = new Date();

  const bhutanDate = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Thimphu" }),
  );

  const yyyy = bhutanDate.getFullYear();
  const mm = String(bhutanDate.getMonth() + 1).padStart(2, "0");
  const dd = String(bhutanDate.getDate()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}`;
}

async function getTodaySalesForBusiness(business_id) {
  const bid = Number(business_id);

  if (!Number.isFinite(bid) || bid <= 0) {
    throw new Error("Invalid business_id. Must be a positive integer.");
  }

  const business = await prisma.merchant_business_details.findUnique({
    where: {
      business_id: bid,
    },
    select: {
      business_id: true,
    },
  });

  if (!business) {
    throw new Error(`Business with ID ${bid} not found.`);
  }

  const today = getBhutanTodayDateString();

  const rows = await prisma.merchant_earnings.findMany({
    where: {
      business_id: bid,
      date: new Date(`${today}T00:00:00.000Z`),
    },
    select: {
      business_id: true,
      date: true,
      total_amount: true,
      order_id: true,
    },
    orderBy: {
      order_id: "desc",
    },
  });

  const netSales = n2(
    rows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0),
  );

  return {
    business_id: bid,
    date: today,
    total_orders: rows.length,

    // Since merchant_earnings stores merchant net earning
    gross_sales: netSales,
    platform_fee_total_share: 0,
    platform_fee_merchant_share: 0,
    net_sales: netSales,

    currency: "Nu",
    source: "merchant_earnings",
    rows,
  };
}

module.exports = {
  getTodaySalesForBusiness,
};