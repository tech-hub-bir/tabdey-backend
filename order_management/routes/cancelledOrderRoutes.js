// routes/cancelledOrderRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/cancelledOrderControllers");

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
// Reads (higher)
const readLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many requests. Please slow down.",
});

// Deletes (tighter)
const deleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 30,
  message: "Too many delete requests. Please try again later.",
});

/* validators */
const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  return Number.isFinite(uid) && uid > 0
    ? next()
    : res.status(400).json({ success: false, message: "Invalid user_id" });
};

const validOrderId = (req, res, next) => {
  const id = String(req.params.order_id || "").trim();
  return id.startsWith("ORD-")
    ? next()
    : res.status(400).json({ success: false, message: "Invalid order_id" });
};

/* Fetch cancelled orders by user */
router.get(
  "/users/:user_id/cancelled-orders",
  validUserId,
  ctrl.getCancelledOrdersByUser,
);

/* Delete ONE cancelled order (also deletes its cancelled items) */
router.delete(
  "/users/:user_id/cancelled-orders/:order_id",
  deleteLimiter,
  validUserId,
  validOrderId,
  ctrl.deleteCancelledOrder,
);

/* Delete MANY cancelled orders (also deletes their cancelled items) */
router.delete(
  "/users/:user_id/cancelled-orders",
  deleteLimiter,
  validUserId,
  ctrl.deleteManyCancelledOrders,
);

module.exports = router;
