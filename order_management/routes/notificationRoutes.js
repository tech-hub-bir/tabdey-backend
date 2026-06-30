// routes/notificationRoutes.js (business notifications)
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  listByBusinessId,
  getOne,
  markOneRead,
  markAllReadForBusiness,
  deleteOne,
} = require("../controllers/notificationController");

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
  windowMs: 60 * 1000, // 1 min
  max: 180,
  message: "Too many requests. Please slow down.",
});

const writeLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 120,
  message: "Too many requests. Please try again shortly.",
});

const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 60,
  message: "Too many delete requests. Please try again later.",
});

/* ---------------- validators ---------------- */
const validBusinessId = (req, res, next) => {
  const id = Number(req.params.businessId);
  if (Number.isFinite(id) && id > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid businessId" });
};

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validNotificationId = (req, res, next) => {
  const id = String(req.params.notificationId || "").trim();
  if (UUID_RX.test(id)) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid notificationId" });
};
/**
 * List notifications for a business (with pagination and unread filter)
 * GET /api/notifications/business/:businessId?limit=50&offset=0&unreadOnly=true
 */
router.get("/business/:businessId", validBusinessId, listByBusinessId);

/**
 * Mark all notifications for a business as read
 * PATCH /api/notifications/business/:businessId/read-all
 */
router.patch(
  "/business/:businessId/read-all",
  writeLimiter,
  validBusinessId,
  markAllReadForBusiness,
);

/**
 * Get a single notification by id
 * GET /api/notifications/:notificationId
 */
router.get("/:notificationId", validNotificationId, getOne);

/**
 * Mark a single notification as read
 * PATCH /api/notifications/:notificationId/read
 */
router.patch(
  "/:notificationId/read",
  writeLimiter,
  validNotificationId,
  markOneRead,
);

/**
 * Delete a notification by id
 * DELETE /api/notifications/:notificationId
 */
router.delete(
  "/:notificationId",
  deleteLimiter,
  validNotificationId,
  deleteOne,
);

module.exports = router;
