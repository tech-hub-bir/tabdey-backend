// routes/merchantEarningsRoutes.js
const express = require("express");
const router = express.Router();

const merchantEarningsCtrl = require("../controllers/merchantEarningsController");

/* validators */
const validBizId = (req, res, next) => {
  const bid = Number(req.params.business_id);
  return Number.isFinite(bid) && bid > 0
    ? next()
    : res.status(400).json({ success: false, message: "Invalid business_id" });
};

/**
 * GET /merchant-earnings/business/:business_id
 * Query (optional):
 *   - from=YYYY-MM-DD
 *   - to=YYYY-MM-DD
 *   - group_by=day|week|month|year (default: day)
 *
 * Examples:
 *   /merchant-earnings/business/12?group_by=day&from=2026-01-01&to=2026-01-31
 *   /merchant-earnings/business/12?group_by=month
 */
router.get(
  "/merchant-earnings/business/:business_id",
  validBizId,
  merchantEarningsCtrl.getMerchantEarningsByBusiness,
);

module.exports = router;
