const { prisma } = require("../lib/prisma");

/**
 * Get all earnings for a specific business
 * Returns all earnings rows with summary statistics
 */
async function getEarningsByBusiness(business_id) {
  try {
    const bid = Number(business_id);
    if (!Number.isInteger(bid) || bid <= 0) {
      throw new Error("Business ID must be a positive integer");
    }

    // Check if business exists
    const business = await prisma.merchant_business_details.findUnique({
      where: { business_id: bid },
      select: { business_id: true },
    });

    if (!business) {
      return {
        success: false,
        message: "Business not found.",
        summary: { total_amount: 0, orders_count: 0, rows_count: 0 },
        rows: [],
      };
    }

    // Fetch all earnings for this business
    const earnings = await prisma.merchant_earnings.findMany({
      where: { business_id: bid },
      orderBy: [
        { date: "desc" },
        { order_id: "desc" },
      ],
      select: {
        business_id: true,
        date: true,
        total_amount: true,
        order_id: true,
      },
    });

    if (!earnings.length) {
      return {
        success: true,
        summary: { total_amount: 0, orders_count: 0, rows_count: 0 },
        rows: [],
      };
    }

    // Calculate summary
    let totalAmount = 0;
    const uniqueOrders = new Set();

    for (const earning of earnings) {
      totalAmount += Number(earning.total_amount || 0);
      uniqueOrders.add(String(earning.order_id));
    }

    // Format rows
    const formattedRows = earnings.map((earning) => ({
      business_id: Number(earning.business_id),
      date: earning.date instanceof Date ? earning.date.toISOString().split('T')[0] : String(earning.date),
      total_amount: Number(Number(earning.total_amount || 0).toFixed(2)),
      order_id: String(earning.order_id),
    }));

    return {
      success: true,
      summary: {
        total_amount: Number(totalAmount.toFixed(2)),
        orders_count: uniqueOrders.size,
        rows_count: earnings.length,
      },
      rows: formattedRows,
    };
  } catch (error) {
    console.error("getEarningsByBusiness error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch earnings",
      summary: { total_amount: 0, orders_count: 0, rows_count: 0 },
      rows: [],
    };
  }
}

module.exports = {
  getEarningsByBusiness,
};