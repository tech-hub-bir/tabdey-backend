const UserModel = require("../models/userModel");
const OtpModel = require("../models/otpModel");
const EmailService = require("../services/emailService");

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

// ✅ Registration (Email) - TàbDey format
exports.sendOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;

    if (!emailRaw) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }

    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address" });
    }

    if (!EmailService.isConfigured()) {
      return res.status(500).json({
        success: false,
        message: "SMTP not configured. Check SMTP_HOST/SMTP_USER/SMTP_PASS",
      });
    }

    const cleanEmail = normalizeEmail(emailRaw);
    const otp = OtpModel.generateOtp();

    // Check if email already registered using UserModel
    const existingUser = await UserModel.findUserByEmail(cleanEmail);

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Email already registered. OTP not sent.",
      });
    }

    // Store OTP in Redis using OtpModel
    await OtpModel.storeOtp(cleanEmail, otp, 300);

    // Send email using EmailService
    const info = await EmailService.sendRegistrationOtp(cleanEmail, otp);

    if (!info?.accepted || info.accepted.length === 0) {
      return res.status(500).json({
        success: false,
        message: "SMTP did not accept recipient",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email",
    });
  } catch (err) {
    console.error("Send OTP error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP",
      error: err?.message || String(err),
    });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const otpRaw = req.body?.otp;

    if (!emailRaw || !otpRaw) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address" });
    }

    const cleanEmail = normalizeEmail(emailRaw);
    const otp = String(otpRaw).trim();

    // Get stored OTP using OtpModel
    const storedOtp = await OtpModel.getOtp(cleanEmail);

    if (!storedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired",
      });
    }

    if (String(storedOtp).trim() !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    // Store verified flag and delete OTP using OtpModel
    await OtpModel.storeVerifiedFlag(cleanEmail, 900);
    await OtpModel.deleteOtp(cleanEmail);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  } catch (err) {
    console.error("Verify OTP error:", err);
    return res.status(500).json({
      success: false,
      message: "OTP verification failed",
      error: err?.message || String(err),
    });
  }
};
