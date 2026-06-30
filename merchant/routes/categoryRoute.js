// routes/categoryRoute.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  createCategoryCtrl,
  listCategoriesCtrl,
  listByBusinessTypeCtrl,
  updateCategoryCtrl,
  deleteCategoryCtrl,
  getCategoriesForBusinessCtrl,
} = require("../controllers/categoryController");

const { uploadCategoryImage } = require("../middlewares/categoryImage");

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
// Reads (higher)
const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

// Create/Update (uploads) (tight)
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
const validateKindParam = (req, res, next) => {
  const k = String(req.params.kind || "").toLowerCase();
  if (k === "food" || k === "mart") {
    req.params.kind = k;
    return next();
  }
  return res.status(400).json({
    success: false,
    message: "Invalid kind. Expected 'food' or 'mart'.",
  });
};

const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

const validateBusinessIdParam = (req, res, next) => {
  const id = Number(req.params.businessId);
  if (Number.isFinite(id) && id > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid businessId" });
};

/* ---------------- routes ---------------- */
// IMPORTANT: keep the more specific route BEFORE "/:kind"
router.get(
  "/business/:businessId",

  validateBusinessIdParam,
  getCategoriesForBusinessCtrl,
);

// CREATE (supports multipart with file field "category_image")
router.post(
  "/:kind",
  validateKindParam,
  writeLimiter,
  uploadCategoryImage(),
  createCategoryCtrl,
);

// UPDATE (partial; auto-delete old image if replaced)
router.put(
  "/:kind/:id",
  validateKindParam,
  writeLimiter,
  validateIdParam,
  uploadCategoryImage(),
  updateCategoryCtrl,
);

// DELETE (also deletes the old image file)
router.delete(
  "/:kind/:id",
  validateKindParam,
  deleteLimiter,
  validateIdParam,
  deleteCategoryCtrl,
);

// FETCH BY business_type (within kind) — query param ?business_type=food|mart (defaults to :kind)
router.get("/:kind/by-type", validateKindParam, listByBusinessTypeCtrl);

// FETCH ALL (by kind)
router.get("/:kind", validateKindParam, listCategoriesCtrl);

module.exports = router;
