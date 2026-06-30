// routes/salesRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const { getTodaySales } = require("../controllers/salesController");

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

/* ---------------- validators ---------------- */
const validateBusinessIdParam = (req, res, next) => {
  const bid = Number(req.params.business_id);

  if (Number.isFinite(bid) && bid > 0) {
    return next();
  }

  return res.status(400).json({
    success: false,
    message: "Invalid business_id",
  });
};

/* ---------------- limiters ---------------- */
const salesReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 180,
  message: "Too many requests. Please slow down.",
});

// GET /api/sales/today/:business_id
router.get(
  "/today/:business_id",
  salesReadLimiter,
  validateBusinessIdParam,
  getTodaySales,
);

module.exports = router;