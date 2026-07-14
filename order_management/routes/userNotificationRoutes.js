// routes/userNotificationRoutes.js (user notifications)
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  listByUserId,
  getOne,
  markOneRead,
  markAllReadForUser,
  deleteOne,
} = require("../controllers/userNotificationController");

const authUser = require("../middleware/authUser");
const { requireSelfOrAdmin } = require("../middleware/authUser");

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
const validUserId = (req, res, next) => {
  const id = Number(req.params.userId);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid userId" });
};

const validNotificationId = (req, res, next) => {
  const id = Number(req.params.notificationId);
  if (Number.isFinite(id) && id > 0) return next();
  return res
    .status(400)
    .json({ success: false, message: "Invalid notificationId" });
};

/**
 * List notifications for a user (with pagination and unread filter)
 * GET /api/notifications/user/:userId?limit=50&offset=0&unreadOnly=true
 */
router.get(
  "/user/:userId",
  authUser,
  validUserId,
  requireSelfOrAdmin("userId"),
  listByUserId,
);

/**
 * Mark all notifications for a user as read
 * PATCH /api/notifications/user/:userId/read-all
 */
router.patch(
  "/user/:userId/read-all",
  authUser,
  writeLimiter,
  validUserId,
  requireSelfOrAdmin("userId"),
  markAllReadForUser,
);

/**
 * Get a single notification by id
 * GET /api/notifications/:notificationId
 */
router.get("/:notificationId", authUser, validNotificationId, getOne);

/**
 * Mark a single notification as read
 * PATCH /api/notifications/:notificationId/read
 */
router.patch(
  "/:notificationId/read",
  authUser,
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
  authUser,
  deleteLimiter,
  validNotificationId,
  deleteOne,
);

module.exports = router;
