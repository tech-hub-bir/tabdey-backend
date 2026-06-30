// routes/martMenuBrowseRoute.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  listMartMenuGroupedByCategoryCtrl,
} = require("../controllers/martMenuBrowseController");

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
  windowMs: 60 * 1000,
  max: 180,
  message: "Too many requests. Please slow down.",
});

const validateBusinessId = (req, res, next) => {
  const id = Number(req.params.business_id);
  if (Number.isFinite(id) && id > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
};

// Example: GET /api/mart/businesses/:business_id/menu-grouped
router.get(
  "/businesses/:business_id/menu-grouped",
  readLimiter,
  validateBusinessId,
  listMartMenuGroupedByCategoryCtrl,
);

module.exports = router;
