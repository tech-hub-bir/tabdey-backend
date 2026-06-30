const {
  getFoodMenuGroupedByCategoryForBusiness,
} = require("../models/foodMenuBrowseModel");

// GET /api/food/businesses/:business_id/menu-grouped
async function listFoodMenuGroupedByCategoryCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const result = await getFoodMenuGroupedByCategoryForBusiness(business_id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Menu grouped by category fetched successfully.",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    console.error("listFoodMenuGroupedByCategoryCtrl error:", error);
    return res.status(500).json({
      success: false,
      message:
        error.message || "Failed to fetch grouped menu. Please try again.",
    });
  }
}

module.exports = { listFoodMenuGroupedByCategoryCtrl };
