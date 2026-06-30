// controllers/salesController.js
const { getTodaySalesForBusiness } = require("../models/salesModel");

/**
 * GET /api/sales/today/:business_id
 */
async function getTodaySales(req, res) {
  try {
    const business_id = Number(req.params.business_id);

    if (!Number.isFinite(business_id) || business_id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid business_id. Must be a positive integer.",
      });
    }

    const stats = await getTodaySalesForBusiness(business_id);

    return res.status(200).json({
      success: true,
      message: "Today's sales fetched successfully.",
      data: stats,
    });
  } catch (err) {
    console.error("[getTodaySales ERROR]", err?.message || err);

    if (err.message && err.message.includes("not found")) {
      return res.status(404).json({
        success: false,
        message: err.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to fetch today's sales. Please try again later.",
      error: err?.message || String(err),
    });
  }
}

module.exports = {
  getTodaySales,
};