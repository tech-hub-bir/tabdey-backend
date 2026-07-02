// routes/smsOtpRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  sendSmsOtp,
  verifySmsOtp,
  changeDeviceOTP,
  changeDeviceOTPVerify,
} = require("../controllers/smsOtpController");

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
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many SMS OTP requests. Please try again later.",
});

const otpVerifyLimiter = makeLimiter({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: 15,
  message: "Too many SMS OTP verification attempts. Please try again later.",
});

/* ---------------- registration SMS OTP ---------------- */
router.post("/send-otp-sms", otpSendLimiter, sendSmsOtp);
router.post("/verify-otp-sms", otpVerifyLimiter, verifySmsOtp);

/* ---------------- change-device SMS OTP ---------------- */
router.post("/send-change-device-otp", changeDeviceOTP);
router.post("/verify-change-device-otp", changeDeviceOTPVerify);

module.exports = router;
