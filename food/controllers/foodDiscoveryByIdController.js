const {
  getFoodBusinessesByBusinessTypeId,
} = require("../models/foodDiscoveryModel");

// GET /api/food/discovery/business-types/businesses/:business_type_id
async function listFoodBusinessesByBusinessTypeIdCtrl(req, res) {
  try {
    const { business_type_id } = req.params;
    const result = await getFoodBusinessesByBusinessTypeId(business_type_id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Food businesses fetched successfully.",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    console.error("listFoodBusinessesByBusinessTypeIdCtrl error:", error);
    return res.status(500).json({
      success: false,
      message:
        error.message || "Failed to fetch food businesses. Please try again.",
    });
  }
}

module.exports = { listFoodBusinessesByBusinessTypeIdCtrl };
