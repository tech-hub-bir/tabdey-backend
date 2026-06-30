// routes/idRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  createTxnIdCtrl,
  createJournalCodeCtrl,
  createBothCtrl,
} = require("../controllers/idController");

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

/**
 * ID generation should be tight (prevents brute/abuse)
 * If these are internal-only endpoints, you can loosen or remove.
 */
const idLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  message: "Too many ID generation requests. Please try again shortly.",
});

router.post("/transaction", idLimiter, createTxnIdCtrl);
router.post("/journal", idLimiter, createJournalCodeCtrl);
router.post("/both", idLimiter, createBothCtrl);

module.exports = router;
