const {
  getMartMenuGroupedByCategoryForBusiness,
} = require("../models/martMenuBrowseModel");

async function listMartMenuGroupedByCategoryCtrl(req, res) {
  try {
    const business_id = req.params.business_id;
    const result = await getMartMenuGroupedByCategoryForBusiness(business_id);

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
    console.error("listMartMenuGroupedByCategoryCtrl error:", error);
    return res.status(500).json({
      success: false,
      message:
        error.message || "Failed to fetch grouped menu. Please try again.",
    });
  }
}

module.exports = { listMartMenuGroupedByCategoryCtrl };
