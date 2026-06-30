const PlatformFeeRule = require("../models/platformFeeRuleModel");

exports.getFeePercentage = async (req, res) => {
  try {
    const rule = await PlatformFeeRule.getFeePercentBp();

    if (!rule) {
      return res.status(404).json({
        success: false,
        message: "No platform fee rule found",
      });
    }

    // Convert basis points → integer percentage
    const percentage = Math.round(Number(rule.fee_percent_bp || 0) / 100);

    res.status(200).json({
      success: true,
      fee_percent_bp: rule.fee_percent_bp,
      fee_percent: percentage,
    });
  } catch (err) {
    console.error("Error fetching platform fee:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};
