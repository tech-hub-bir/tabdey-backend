const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  uploadBannerImage,
  createBannerCtrl,
  listBannersCtrl,
  getBannerCtrl,
  listAllBannersByBusinessCtrl,
  listActiveFoodCtrl,
  listActiveMartCtrl,
  updateBannerCtrl,
  deleteBannerCtrl,
  getBannerBasePriceCtrl,
} = require("../controllers/bannerController");

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

/* ---------------- limiters (tune as needed) ---------------- */
// Public read endpoints (higher)
const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

// Business scoped listing (moderate)
const businessReadLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  message: "Too many requests. Please try again shortly.",
});

// Create/update (uploads) (tight)
const writeLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 20,
  message: "Too many banner changes. Please try again later.",
});

// Delete (tight)
const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 10,
  message: "Too many delete requests. Please try again later.",
});

/* validators */
const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

const validateBusinessIdParam = (req, res, next) => {
  const bid = Number(req.params.business_id);
  if (Number.isFinite(bid) && bid > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
};

/* ---------------- routes ---------------- */

// Create (multipart or JSON base64; field: banner_image OR image)
router.post("/", writeLimiter, uploadBannerImage(), createBannerCtrl);

/**
 * ACTIVE endpoints:
 *  - GET /api/banners/food?business_id=(optional)
 *  - GET /api/banners/mart?business_id=(optional)
 */
router.get("/food", listActiveFoodCtrl);
router.get("/mart", listActiveMartCtrl);
router.get("/base-price", getBannerBasePriceCtrl);

/**
 * By business: fetch ALL banners (active + inactive), optional ?owner_type=food|mart
 */
router.get(
  "/business/:business_id",
  validateBusinessIdParam,
  listAllBannersByBusinessCtrl,
);

/**
 * Generic list (admin/debug) — supports ?business_id=&active_only=1&owner_type=food|mart
 */
router.get("/", listBannersCtrl);

// Single banner (no active filter)
router.get("/:id", validateIdParam, getBannerCtrl);

// Update (supports image replacement / clearing)
router.put(
  "/:id",
  writeLimiter,
  validateIdParam,
  uploadBannerImage(),
  updateBannerCtrl,
);

// Delete
router.delete("/:id", deleteLimiter, validateIdParam, deleteBannerCtrl);

module.exports = router;
