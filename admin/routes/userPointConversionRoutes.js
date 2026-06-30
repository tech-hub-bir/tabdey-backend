const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const pointConversionController = require("../controllers/pointConversionController");
const userAuth = require("../middleware/auth");

const conversionLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message: "Too many conversion requests. Please try again later.",
    }),
});

// POST /api/user/points/convert
router.post(
  "/points/convert",
  userAuth,
  conversionLimiter,
  pointConversionController.convertPointsToWallet,
);

module.exports = router;
