const { prisma } = require("../lib/prisma.js");
const redisClient = require("../models/redisClient");
const bcrypt = require("bcrypt");

// ✅ use your existing mailer config
const { transporter, from, isConfigured } = require("../config/mailer");

/* ---------------- fetch (Node 18+ has global fetch) ---------------- */
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

/* ---------------- SMS gateway config ---------------- */
const SMS_URL = process.env.SMS_URL;
const SMS_MASTER_KEY = (process.env.SMS_MASTER_KEY || "").trim();
const SMS_FROM = process.env.SMS_FROM.trim();

/* ---------------- helpers ---------------- */

// keep lookup "not normalized": we generate candidates, but we only normalize AFTER user exists
function buildLookupCandidates(input) {
  const raw = String(input || "").trim();
  if (!raw) return [];

  const digits = raw.replace(/[^\d]/g, "");
  const candidates = new Set();

  // as-is raw (maybe DB stores like "975...." or "17....")
  candidates.add(raw);

  // digits-only version
  if (digits) candidates.add(digits);

  // if user typed 8 digits, also try adding 975 for lookup
  if (digits.length === 8) candidates.add(`975${digits}`);

  return Array.from(candidates).filter(Boolean);
}

function normalizeForGateway(phoneFromDbOrMatch) {
  const raw = String(phoneFromDbOrMatch || "").trim();
  const digits = raw.replace(/[^\d]/g, "");

  // 8 digits -> prefix 975
  if (digits.length === 8) return `975${digits}`;

  // 975xxxxxxxx (11 digits)
  if (digits.length === 11 && digits.startsWith("975")) return digits;

  return null;
}

function makeOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeRole(raw) {
  if (raw == null) return null;

  const value = String(raw).trim().toLowerCase();

  const aliases = {
    superadmin: "super_admin",
    "super admin": "super_admin",
  };

  return aliases[value] || value || null;
}

const ALLOWED_ACCOUNT_ROLES = [
  "user",
  "merchant",
  "driver",
  "organizer",
  "finance",
  "admin",
  "super_admin",
];

async function sendSmsGateway({ to, text, from }) {
  if (!SMS_MASTER_KEY) throw new Error("SMS_MASTER_KEY missing in .env");

  const resp = await fetchFn(SMS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SMS_MASTER_KEY,
    },
    body: JSON.stringify({ to, text, from }),
  });

  const bodyText = await resp.text();
  if (!resp.ok)
    throw new Error(`SMS gateway error ${resp.status}: ${bodyText}`);
  return bodyText;
}

/**
 * Find user by phone WITHOUT normalizing input first.
 * We check DB using candidates from raw input.
 * If user found, we then normalize the stored phone for sending.
 */
async function findUserByPhoneNoNormalize(inputPhone, role) {
  const candidates = buildLookupCandidates(inputPhone);
  if (!candidates.length) return { user: null, gatewayPhone: null };

  // ✅ Using Prisma to find user by multiple phone candidates, scoped to role
  let user = null;

  for (const candidate of candidates) {
    const found = await prisma.users.findFirst({
      where: { phone: candidate, role },
      select: { user_id: true, role: true, phone: true },
    });

    if (found) {
      user = found;
      break;
    }
  }

  if (!user) return { user: null, gatewayPhone: null };

  // Normalize only AFTER user exists (prefer DB stored phone)
  const stored = user.phone || "";
  const gatewayPhone =
    normalizeForGateway(stored) || normalizeForGateway(candidates[0]);

  return { user, gatewayPhone };
}

/* ============================================================
   ✅ 1) SEND OTP SMS (Forgot password)
   Body: { phone }
   - ✅ ONLY sends if phone exists in DB
   - OTP valid: 5 minutes
   ============================================================ */
exports.sendOtpSms = async (req, res) => {
  try {
    const inputPhone = req.body.phone;
    const role = normalizeRole(req.body.role);

    if (!role) {
      return res.status(400).json({ error: "Role is required." });
    }

    if (!ALLOWED_ACCOUNT_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }

    const { user, gatewayPhone } = await findUserByPhoneNoNormalize(
      inputPhone,
      role,
    );

    // ✅ IMPORTANT: don't send if not registered
    if (!user) {
      return res.status(404).json({
        error: `No ${role} account was found with this phone number.`,
      });
    }

    if (!gatewayPhone) {
      return res
        .status(400)
        .json({ error: "No valid phone number found for this account." });
    }

    // resend cooldown 30s
    const rlKey = `fp_sms_rl:${role}:${gatewayPhone}`;
    if (await redisClient.get(rlKey)) {
      return res
        .status(429)
        .json({ error: "Please wait before requesting another OTP." });
    }

    const otp = makeOtp();

    // store OTP 5 mins
    const otpKey = `fp_sms_otp:${role}:${gatewayPhone}`;
    await redisClient.set(otpKey, otp, { ex: 300 });
    await redisClient.set(rlKey, "1", { ex: 30 });

    const text =
      `Password reset code\n\n` +
      `${otp}\n\n` +
      `This code is valid for 5 minutes.\n` +
      `Do not share this code with anyone.`;

    await sendSmsGateway({
      to: gatewayPhone,
      text,
      from: SMS_FROM,
    });

    return res.status(200).json({
      message: "OTP sent via SMS.",
    });
  } catch (err) {
    console.error("Send OTP SMS Error:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/* ============================================================
   ✅ 2) VERIFY OTP SMS
   Body: { phone, otp }
   - ✅ verifies only if phone exists in DB
   - sets verified flag for 15 mins
   ============================================================ */
exports.verifyOtpSms = async (req, res) => {
  try {
    const inputPhone = req.body.phone;
    const otp = String(req.body.otp || "").trim();
    const role = normalizeRole(req.body.role);

    if (!inputPhone || !otp) {
      return res.status(400).json({ error: "Phone and OTP are required" });
    }

    if (!role) {
      return res.status(400).json({ error: "Role is required." });
    }

    if (!ALLOWED_ACCOUNT_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }

    const { user, gatewayPhone } = await findUserByPhoneNoNormalize(
      inputPhone,
      role,
    );

    if (!user) {
      return res.status(404).json({
        error: `No ${role} account was found with this phone number.`,
      });
    }

    if (!gatewayPhone) {
      return res
        .status(400)
        .json({ error: "No valid phone number found for this account." });
    }

    const otpKey = `fp_sms_otp:${role}:${gatewayPhone}`;
    const storedOtp = await redisClient.get(otpKey);

    if (!storedOtp)
      return res.status(410).json({ error: "OTP expired or not found" });
    if (String(storedOtp).trim() !== otp)
      return res.status(401).json({ error: "Invalid OTP" });

    const verifiedKey = `fp_sms_verified:${role}:${gatewayPhone}`;
    await redisClient.set(verifiedKey, "true", { ex: 900 }); // 15 mins
    await redisClient.del(otpKey);

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("Verify OTP SMS Error:", err.message);
    return res.status(500).json({ error: "Internal server error." });
  }
};

/* ============================================================
   ✅ 3) RESET PASSWORD BY PHONE
   POST /reset-password-sms
   Body: { phone, newPassword }
   - requires verifyOtpSms first (verified flag)
   ============================================================ */
exports.resetPasswordSms = async (req, res) => {
  try {
    const inputPhone = req.body.phone;
    const newPassword = String(req.body.newPassword || "");
    const role = normalizeRole(req.body.role);

    if (!inputPhone || !newPassword) {
      return res.status(400).json({
        error: "Phone and newPassword are required.",
      });
    }

    if (!role) {
      return res.status(400).json({ error: "Role is required." });
    }

    if (!ALLOWED_ACCOUNT_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role." });
    }

    if (newPassword.trim().length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters.",
      });
    }

    const { user, gatewayPhone } = await findUserByPhoneNoNormalize(
      inputPhone,
      role,
    );

    if (!user) {
      return res.status(404).json({
        error: `No ${role} account was found with this phone number.`,
      });
    }

    if (!gatewayPhone) {
      return res
        .status(400)
        .json({ error: "No valid phone number found for this account." });
    }

    // must be verified
    const verifiedKey = `fp_sms_verified:${role}:${gatewayPhone}`;
    const verified = await redisClient.get(verifiedKey);

    if (!verified) {
      return res.status(403).json({
        error: "OTP not verified. Please verify OTP first.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password using Prisma
    await prisma.users.update({
      where: { user_id: user.user_id },
      data: { password_hash: hashedPassword },
    });

    // cleanup verification flag
    await redisClient.del(verifiedKey);

    return res.status(200).json({ message: "Password reset successfully." });
  } catch (err) {
    console.error("Reset Password SMS Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/* ===========================
   ✅ EMAIL OTP FLOW
   - uses config/mailer.js transporter/from
   - normalizes email for redis keys
   - proper success/error responses
   - adds verified flag (15 mins) like SMS flow
=========================== */

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();
const isValidEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());

/* ============================================================
   ✅ SEND OTP TO EMAIL (Forgot password)
   Body: { email }
   - only sends if email exists in DB
   - OTP valid: 5 mins
   - resend cooldown: 30s
   ============================================================ */
exports.sendOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const role = normalizeRole(req.body?.role);

    if (!emailRaw) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required." });
    }
    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address." });
    }

    if (!role) {
      return res
        .status(400)
        .json({ success: false, message: "Role is required." });
    }

    if (!ALLOWED_ACCOUNT_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid role." });
    }

    const email = normalizeEmail(emailRaw);

    // ✅ Using Prisma to find user by email, scoped to role
    const user = await prisma.users.findFirst({
      where: { email: email, role },
      select: { user_id: true, role: true, email: true, user_name: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: `No ${role} account was found with this email.`,
      });
    }

    if (!isConfigured || !transporter || !from) {
      return res.status(500).json({
        success: false,
        message: "Email service not configured on server.",
      });
    }

    // resend cooldown 30s
    const rlKey = `fp_email_rl:${role}:${email}`;
    if (await redisClient.get(rlKey)) {
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP.",
      });
    }

    const otp = makeOtp();

    const otpKey = `fp_email_otp:${role}:${email}`;
    await redisClient.set(otpKey, otp, { ex: 300 });
    await redisClient.set(rlKey, "1", { ex: 30 });

    const userName = user.user_name || "Valued User";
    const disclaimer =
      "Disclaimer: Please do NOT share this OTP or your password with anyone. " +
      "TàbDey will never ask for your OTP, password, or T-PIN. " +
      "If you did not request a password reset, please ignore this email.";

    const subject = "Your OTP for Password Reset";

    const text =
      `Dear ${userName},\n\n` +
      `We received a request to reset your TàbDey account password.\n\n` +
      `Your OTP is:\n\n` +
      `${otp}\n\n` +
      `This OTP is valid for 5 minutes and can only be used once.\n\n` +
      `${disclaimer}\n\n` +
      `Everything at your door step!\n` +
      `TàbDey`;

    const html =
      `<p>Dear ${userName},</p>` +
      `<p>We received a request to reset your <b>TàbDey</b> account password.</p>` +
      `<p>Your OTP is:</p>` +
      `<h2 style="letter-spacing:4px;">${otp}</h2>` +
      `<p>This OTP is valid for <b>5 minutes</b> and can only be used once.</p>` +
      `<hr />` +
      `<p style="font-size:12px;color:#777;">${disclaimer}</p>` +
      `<p><b>Everything at your door step!</b><br/>TàbDey</p>`;

    const info = await transporter.sendMail({
      from,
      to: email,
      subject,
      text,
      html,
    });

    if (!info?.accepted || info.accepted.length === 0) {
      return res.status(500).json({
        success: false,
        message: "SMTP did not accept recipient.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "OTP sent to email.",
    });
  } catch (err) {
    console.error("Send OTP Email Error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send OTP.",
      error: err?.message || String(err),
    });
  }
};

/* ============================================================
   ✅ VERIFY EMAIL OTP
   Body: { email, otp }
   - verified flag valid: 15 mins
   ============================================================ */
exports.verifyOtp = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const otpRaw = req.body?.otp;
    const role = normalizeRole(req.body?.role);

    if (!emailRaw || !otpRaw) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required.",
      });
    }
    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address." });
    }

    if (!role) {
      return res
        .status(400)
        .json({ success: false, message: "Role is required." });
    }

    if (!ALLOWED_ACCOUNT_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid role." });
    }

    const email = normalizeEmail(emailRaw);
    const otp = String(otpRaw).trim();

    // ✅ ensure email exists in DB, scoped to role
    const user = await prisma.users.findFirst({
      where: { email: email, role },
      select: { user_id: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: `No ${role} account was found with this email.`,
      });
    }

    const otpKey = `fp_email_otp:${role}:${email}`;
    const storedOtp = await redisClient.get(otpKey);

    if (!storedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired or not found.",
      });
    }

    if (String(storedOtp).trim() !== otp) {
      return res.status(401).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    // mark verified for 15 mins, clear OTP
    const verifiedKey = `fp_email_verified:${role}:${email}`;
    await redisClient.set(verifiedKey, "true", { ex: 900 });
    await redisClient.del(otpKey);

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
    });
  } catch (err) {
    console.error("Verify OTP Email Error:", err);
    return res.status(500).json({
      success: false,
      message: "OTP verification failed.",
      error: err?.message || String(err),
    });
  }
};

/* ============================================================
   ✅ RESET PASSWORD (email)
   Body: { email, newPassword }
   - requires verifyOtp first (verified flag)
   ============================================================ */
exports.resetPassword = async (req, res) => {
  try {
    const emailRaw = req.body?.email;
    const newPassword = String(req.body?.newPassword || "");
    const role = normalizeRole(req.body?.role);

    if (!emailRaw || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Email and new password are required.",
      });
    }
    if (!isValidEmail(emailRaw)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid email address." });
    }

    if (!role) {
      return res
        .status(400)
        .json({ success: false, message: "Role is required." });
    }

    if (!ALLOWED_ACCOUNT_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid role." });
    }

    if (newPassword.trim().length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters.",
      });
    }

    const email = normalizeEmail(emailRaw);

    // ✅ Using Prisma to find user, scoped to role
    const user = await prisma.users.findFirst({
      where: { email: email, role },
      select: { user_id: true, role: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: `No ${role} account was found with this email.`,
      });
    }

    // must be verified
    const verifiedKey = `fp_email_verified:${role}:${email}`;
    const verified = await redisClient.get(verifiedKey);
    if (!verified) {
      return res.status(403).json({
        success: false,
        message: "OTP not verified. Please verify OTP first.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // ✅ Update using Prisma — scoped by user_id since email alone
    // isn't unique (only the [email, role] pair is, per schema.prisma)
    await prisma.users.update({
      where: { user_id: user.user_id },
      data: { password_hash: hashedPassword },
    });

    // cleanup verification flag
    await redisClient.del(verifiedKey);

    return res.status(200).json({
      success: true,
      message: "Password reset successfully.",
    });
  } catch (err) {
    console.error("Reset Password Email Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
};
