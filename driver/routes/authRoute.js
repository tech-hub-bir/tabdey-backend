// routes/authRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { sendOtp, verifyOtp } = require("../controllers/authController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

/**
 * OTP SEND: tighter (prevents spam)
 * OTP VERIFY: moderate (user may retry a few times)
 */
const otpSendLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,
  message: "Too many OTP requests. Please try again later.",
});

const otpVerifyLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: "Too many OTP verification attempts. Please try again later.",
});

router.post("/send-otp", otpSendLimiter, sendOtp);
router.post("/verify-otp", otpVerifyLimiter, verifyOtp);

module.exports = router;
