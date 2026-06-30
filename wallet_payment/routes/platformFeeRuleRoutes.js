// routes/platformFeeRuleRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const controller = require("../controllers/platformFeeRuleController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const retryAfterSeconds = req.rateLimit?.resetTime
        ? Math.max(
            0,
            Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000),
          )
        : undefined;

      return res.status(429).json({
        success: false,
        message,
        retry_after_seconds: retryAfterSeconds,
      });
    },
  });

const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 240,
  message: "Too many requests. Please slow down.",
});

// GET /api/platform-fee-rules/percent
router.get("/percent", readLimiter, controller.getFeePercentage);

module.exports = router;
