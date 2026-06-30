// routes/urlCipherRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  createEncryptedUrlController,
  openEncryptedUrlController,
} = require("../controllers/urlCipherController");

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
// Creating share links: tighter (prevents spam)
const createLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message: "Too many link creation requests. Please try again later.",
});

// Opening links: allow more, but still protect from abuse
const openLimiter = makeLimiter({
  windowMs: 60 * 1000, // 1 min
  max: 300,
  message: "Too many requests. Please slow down.",
});

// Create shareable encrypted link
router.post("/", createLimiter, createEncryptedUrlController);

// Open token (GET proxy)
router.get("/:token", openEncryptedUrlController);

module.exports = router;
