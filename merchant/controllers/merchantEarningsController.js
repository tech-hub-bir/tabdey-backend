const MerchantEarnings = require("../models/merchantEarningsModel");

exports.getMerchantEarningsByBusiness = async (req, res) => {
  try {
    const business_id = Number(req.params.business_id);

    if (!Number.isInteger(business_id) || business_id <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid business_id. Must be a positive integer.",
      });
    }

    const result = await MerchantEarnings.getEarningsByBusiness(business_id);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      business_id: business_id,
      summary: result.summary,
      rows: result.rows,
    });
  } catch (err) {
    console.error("[getMerchantEarningsByBusiness]", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error. Please try again later.",
    });
  }
};