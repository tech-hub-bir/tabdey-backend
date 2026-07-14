// routes/profileRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const profileController = require("../controllers/profileController");
const upload = require("../middleware/upload");
const authUser = require("../middleware/authUser");
const { requireSelfOrAdmin } = require("../middleware/authUser");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

/* ---------------- validators ---------------- */
const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  if (Number.isFinite(uid) && uid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid user_id" });
};

/* ---------------- limiters ---------------- */
const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

const updateLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30,
  message: "Too many profile update requests. Please try again later.",
});

const passwordLimiter = makeLimiter({
  windowMs: 30 * 60 * 1000, // 30 min
  max: 10,
  message: "Too many password change attempts. Please try again later.",
});

// Get profile
router.get(
  "/:user_id",
  authUser,
  validUserId,
  requireSelfOrAdmin,
  profileController.getProfile,
);

// Update profile (with optional image)
// ✅ limiter BEFORE upload middleware
router.put(
  "/:user_id",
  authUser,
  updateLimiter,
  validUserId,
  requireSelfOrAdmin,
  upload.single("profile_image"),
  profileController.updateProfile,
);

// Change password
router.put(
  "/password/:user_id",
  authUser,
  passwordLimiter,
  validUserId,
  requireSelfOrAdmin,
  profileController.changePassword,
);

module.exports = router;
