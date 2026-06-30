// routes/martMenuRoute.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  createMartMenuCtrl,
  listMartMenuCtrl,
  listMartMenuByBusinessCtrl,
  getMartMenuByIdCtrl,
  updateMartMenuCtrl,
  deleteMartMenuCtrl,
} = require("../controllers/martMenuController");

const { uploadMartMenuImage } = require("../middlewares/uploadMartMenuImage");

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

/* ---------------- limiters ---------------- */
const readLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 180,
  message: "Too many requests. Please slow down.",
});

const writeLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many menu changes. Please try again later.",
});

const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: "Too many delete requests. Please try again later.",
});

/* ---------------- validators ---------------- */
const validateIdParam = (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid id" });
};

const validateBusinessIdParam = (req, res, next) => {
  const id = Number(req.params.business_id);
  if (Number.isFinite(id) && id > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid business_id" });
};

// Create (multipart OR JSON with base64)
// ✅ limiter BEFORE upload middleware
router.post("/", writeLimiter, uploadMartMenuImage, createMartMenuCtrl);

// List (supports ?business_id=&category_name=)
router.get("/", readLimiter, listMartMenuCtrl);

// All by business
router.get(
  "/business/:business_id",
  // readLimiter,
  validateBusinessIdParam,
  listMartMenuByBusinessCtrl,
);

// One by id
router.get("/:id", readLimiter, validateIdParam, getMartMenuByIdCtrl);

// Update (supports image replacement, server path, or clearing NULL; JSON base64 also OK)
// ✅ limiter BEFORE upload middleware
router.put(
  "/:id",
  writeLimiter,
  validateIdParam,
  uploadMartMenuImage,
  updateMartMenuCtrl,
);

// Delete
router.delete("/:id", deleteLimiter, validateIdParam, deleteMartMenuCtrl);

module.exports = router;
