const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const authUser = require("../middleware/auth");

const {
  getFoodOrdersReport,
  getMartOrdersReport,
  getFoodMartRevenueReport,
} = require("../controllers/ordersReportController");

const reportLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      success: false,
      message: "Too many report requests. Please slow down.",
    }),
});

// All report endpoints require admin authentication
router.get("/food-orders", authUser, reportLimiter, getFoodOrdersReport);
router.get("/mart-orders", authUser, reportLimiter, getMartOrdersReport);
router.get(
  "/food-mart-revenue",
  authUser,
  reportLimiter,
  getFoodMartRevenueReport,
);

module.exports = router;
