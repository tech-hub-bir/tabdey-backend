// routes/martCartRoute.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  addToCart,
  getCart,
  updateCart,
  deleteItem,
  deleteEntireCart,
} = require("../controllers/cartController");

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
const cartReadLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 180,
  message: "Too many cart requests. Please slow down.",
});

const cartWriteLimiter = makeLimiter({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 120,
  message: "Too many cart changes. Please try again shortly.",
});

const cartDeleteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 60,
  message: "Too many delete requests. Please try again later.",
});

/* ---------------- validators ---------------- */
const validQueryUserId = (req, res, next) => {
  const uid = Number(req.query.user_id);
  if (Number.isFinite(uid) && uid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid user_id" });
};

const validCartIdParam = (req, res, next) => {
  const cid = Number(req.params.cart_id);
  if (Number.isFinite(cid) && cid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid cart_id" });
};

const validMenuIdParam = (req, res, next) => {
  const mid = Number(req.params.menu_id);
  if (Number.isFinite(mid) && mid > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid menu_id" });
};

// Add item(s) to cart
router.post("/add", cartWriteLimiter, addToCart);

// Get cart by user_id (expects ?user_id=... in query)
router.get("/get", validQueryUserId, getCart);

// Update quantity of a cart item
router.put("/update", cartWriteLimiter, updateCart);

// Delete single item
router.delete(
  "/delete-item/:cart_id/:menu_id",
  cartDeleteLimiter,
  validCartIdParam,
  validMenuIdParam,
  deleteItem,
);

// Delete entire cart
router.delete(
  "/delete/:cart_id",
  cartDeleteLimiter,
  validCartIdParam,
  deleteEntireCart,
);

module.exports = router;
