// routes/systemNotificationRoute.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const adminAuth = require("../middleware/adminAuth");

const {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
  sendSmsToSingleUser,
  sendEmailToSingleUser,
  getSingleUserDeliveryLogsByUserIdController,
} = require("../controllers/systemNotificationController");

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const readLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many requests. Please slow down.",
});

const sendLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message: "Too many notification send requests. Please try again later.",
});

const createLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many requests. Please try again later.",
});

/* ======================================================
   ADMIN ROUTES (require Admin Bearer Token)
   POST, PUT, DELETE endpoints only
======================================================= */

// Create notification (admin only)
router.post("/", adminAuth, createLimiter, createSystemNotification);

// Get all in_app notifications (public)
router.get("/all", readLimiter, getAllSystemNotificationsController);

// Send to ONE user (admin only)
router.post("/user/sms", adminAuth, sendLimiter, sendSmsToSingleUser);
router.post("/user/email", adminAuth, sendLimiter, sendEmailToSingleUser);

// Fetch single-user logs (admin only)
router.get(
  "/user/logs/:target_user_id",
  adminAuth,
  readLimiter,
  getSingleUserDeliveryLogsByUserIdController,
);

/* ======================================================
   USER ROUTE (public - no token needed)
   User is identified by userId in URL
   keep this LAST
======================================================= */
router.get("/:userId", readLimiter, getSystemNotificationsByUser);

module.exports = router;
