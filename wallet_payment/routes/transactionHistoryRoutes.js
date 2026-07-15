// routes/transactionHistoryRoutes.js
const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/transactionHistoryController");
const authUser = require("../middleware/authUser");

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

/* ---------------- validators ---------------- */
const validWalletId = (req, res, next) => {
  const wid = String(req.params.wallet_id || "").trim();
  // adjust pattern if your wallet ids differ
  if (!wid) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid wallet_id" });
  }
  next();
};

const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  if (!Number.isFinite(uid) || uid <= 0) {
    return res.status(400).json({ success: false, message: "Invalid user_id" });
  }
  next();
};

/* ---------------- limiters ---------------- */
// Transaction history can be heavy on DB, so moderate read limits
const txnReadLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 120,
  message: "Too many transaction history requests. Please slow down.",
});

// Admin getall should be tighter (and ideally admin-only)
const getAllLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 30,
  message: "Too many requests. Please try again shortly.",
});

// GET /transactions/wallet/NET000004?limit=50&cursor=...&start=...&end=...&direction=CR|DR&journal=...&q=...
router.get(
  "/wallet/:wallet_id",
  authUser,
  validWalletId,
  ctrl.getByWallet,
);

// GET /transactions/user/123?...
router.get("/user/:user_id", authUser, validUserId, ctrl.getByUser);

// GET /transactions/getall?limit=...  (admin-only, enforced in controller)
router.get("/getall", authUser, getAllLimiter, ctrl.getAll);

module.exports = router;
