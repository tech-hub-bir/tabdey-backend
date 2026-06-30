// routes/businessTypesRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  listBusinessTypes,
  getBusinessType,
  listFoodBusinessTypes,
  listMartBusinessTypes,
  createBusinessType,
  updateBusinessType,
  removeBusinessType,
} = require("../controllers/businessTypesController");

const {
  uploadBusinessTypeImage,
} = require("../middlewares/businessTypesImage");

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
// Read endpoints (higher)
const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

// Create/Update (upload) (tight)
const writeLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30,
  message: "Too many changes. Please try again later.",
});

// Delete (tight)
const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 20,
  message: "Too many delete requests. Please try again later.",
});

/* ---------------- validators ---------------- */
const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

/* ---------------- routes ---------------- */

// list/get
router.get("/business-types", listBusinessTypes);
router.get("/business-types/:id", validateIdParam, getBusinessType);
router.get("/business-types/type/food", listFoodBusinessTypes);
router.get("/business-types/type/mart", listMartBusinessTypes);

// create/update with image upload (field name: "image")
// ✅ limiter BEFORE upload middleware (so blocked requests don’t parse files)
router.post(
  "/business-types",
  writeLimiter,
  uploadBusinessTypeImage,
  createBusinessType,
);

router.put(
  "/business-types/:id",
  writeLimiter,
  validateIdParam,
  uploadBusinessTypeImage,
  updateBusinessType,
);

// delete
router.delete(
  "/business-types/:id",
  deleteLimiter,
  validateIdParam,
  removeBusinessType,
);

module.exports = router;
