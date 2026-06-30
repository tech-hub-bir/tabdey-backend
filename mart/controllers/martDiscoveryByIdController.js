const {
  getMartBusinessesByBusinessTypeId,
} = require("../models/martDiscoveryByIdModel");

async function listMartBusinessesByBusinessTypeIdCtrl(req, res) {
  try {
    const { business_type_id } = req.params;
    const result = await getMartBusinessesByBusinessTypeId(business_type_id);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Mart businesses fetched successfully.",
      data: result.data,
      meta: result.meta,
    });
  } catch (error) {
    console.error("listMartBusinessesByBusinessTypeIdCtrl error:", error);
    return res.status(500).json({
      success: false,
      message:
        error.message || "Failed to fetch mart businesses. Please try again.",
    });
  }
}

module.exports = { listMartBusinessesByBusinessTypeIdCtrl };
