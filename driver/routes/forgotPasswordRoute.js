// routes/forgotPasswordRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const controller = require("../controllers/forgotPasswordController");

/* ---------------- rate limit helper ---------------- */
const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

/* ---------------- limiters ---------------- */
const otpSendLimiter = makeLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: "Too many OTP requests. Please try again later.",
});

const otpVerifyLimiter = makeLimiter({
  windowMs: 30 * 60 * 1000, // 30 min
  max: 15,
  message: "Too many OTP verification attempts. Please try again later.",
});

const resetLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: "Too many password reset attempts. Please try again later.",
});

router.post("/send-otp", otpSendLimiter, controller.sendOtp);
router.post("/verify-otp", otpVerifyLimiter, controller.verifyOtp);

router.post("/send-otp-sms", otpSendLimiter, controller.sendOtpSms);
router.post("/verify-otp-sms", otpVerifyLimiter, controller.verifyOtpSms);

router.post("/reset-password", resetLimiter, controller.resetPassword);
router.post("/reset-password-sms", resetLimiter, controller.resetPasswordSms);

module.exports = router;
