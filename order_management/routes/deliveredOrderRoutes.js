// routes/deliveredOrderRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  listDeliveredOrders,
  deleteDeliveredOrder,
  deleteManyDeliveredOrders,
} = require("../controllers/deliveredOrderControllers");

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
function validUserId(req, res, next) {
  const userId = Number(req.params.user_id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid user_id" });
  }
  next();
}

function validOrderId(req, res, next) {
  const oid = String(req.params.order_id || "").trim();
  if (!oid || !/^ORD-\d+$/i.test(oid)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid order_id" });
  }
  next();
}

// GET delivered orders by user
router.get("/:user_id", validUserId, listDeliveredOrders);

// DELETE ONE delivered order by user (items cascade)
router.delete(
  "/:user_id/:order_id",
  deleteLimiter,
  validUserId,
  validOrderId,
  deleteDeliveredOrder,
);

// DELETE MANY delivered orders by user (body: { order_ids: [...] })
router.delete(
  "/:user_id",
  deleteLimiter,
  validUserId,
  deleteManyDeliveredOrders,
);

module.exports = router;
