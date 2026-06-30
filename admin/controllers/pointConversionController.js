const pointConversionModel = require("../models/pointConversionModel");

// POST /api/user/points/convert
// body: { points: 550 }
exports.convertPointsToWallet = async (req, res) => {
  const user = req.user || {};
  const userId = user.user_id || user.id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized. User id missing.",
    });
  }

  try {
    const { points } = req.body || {};
    const pointsToConvert = Number(points);

    if (!Number.isFinite(pointsToConvert) || pointsToConvert <= 0) {
      return res.status(400).json({
        success: false,
        error: "points must be a positive number.",
      });
    }

    const result = await pointConversionModel.convertPointsToWallet(
      userId,
      pointsToConvert,
    );

    return res.status(200).json({
      success: true,
      message: "Points converted successfully.",
      data: {
        points_converted: result.points_converted,
        wallet_amount: result.wallet_amount,
        transaction_id: result.transaction_id,
        journal_code: result.journal_code,
        calculation: result.calculation,
      },
    });
  } catch (err) {
    console.error("Error converting points to wallet:", err);

    const code = err.code || "";

    if (
      code === "RULE_NOT_FOUND" ||
      code === "RULE_INACTIVE" ||
      code === "RULE_INVALID_CONFIG"
    ) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }

    if (
      code === "NOT_ENOUGH_POINTS_FOR_CONVERSION" ||
      code === "INSUFFICIENT_USER_POINTS" ||
      code === "USER_NOT_FOUND" ||
      code === "ADMIN_WALLET_INSUFFICIENT" ||
      code === "ADMIN_WALLET_NOT_FOUND" ||
      code === "USER_WALLET_NOT_FOUND" ||
      code === "TXN_ID_FETCH_FAILED"
    ) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to convert points. Please try again.",
    });
  }
};
