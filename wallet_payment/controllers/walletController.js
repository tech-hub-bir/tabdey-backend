// controllers/walletController.js
const {
  createWallet,
  getWallet,
  getWalletByUserId,
  listWallets,
  updateWalletStatus,
  deleteWallet,
  setWalletTPin,
} = require("../models/walletModel");

const { adminTipTransfer } = require("../models/adminTransferModel");
const { userWalletTransfer } = require("../models/userTransferModel");

const { prisma } = require("../lib/prisma");

const { toThimphuString } = require("../utils/time");
const bcrypt = require("bcryptjs");
const redis = require("../utils/redisClient");
const { sendOtpEmail } = require("../utils/mailer");
const {
  createWalletTransactionLog,
} = require("../models/walletTransactionLogModel");

/* ---------------- SMS ENV ---------------- */
const SMS_API_URL = process.env.SMS_API_URL && process.env.SMS_API_URL.trim();
const SMS_API_KEY = (process.env.SMS_API_KEY || "").trim();
const SMS_FROM = (process.env.SMS_FROM || "Tabdey").trim();

/* ---------------- EXPO PUSH ENV ---------------- */
const EXPO_NOTIFICATION_URL = (process.env.EXPO_NOTIFICATION_URL || "").trim();

/* =========================
   HELPERS
========================= */

function mapLocalTimes(row) {
  if (!row) return row;

  return {
    ...row,
    created_at: toThimphuString(row.created_at),
    updated_at: toThimphuString(row.updated_at),
  };
}

// Never return the T-PIN hash to any client, including the wallet owner.
function sanitizeWallet(row) {
  if (!row) return row;
  const mapped = mapLocalTimes(row);
  const { t_pin, ...rest } = mapped;
  return rest;
}

function isAdminRole(role) {
  const r = String(role || "").toLowerCase().trim();
  return r === "admin" || r === "super_admin" || r === "super admin" || r === "finance";
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: "Admin privileges required.",
    });
  }
  return next();
}

// TD12345678 -> TD*****78
function maskWallet(walletId) {
  if (!walletId || walletId.length < 5) return walletId;

  const prefix = walletId.slice(0, 2);
  const last2 = walletId.slice(-2);
  const maskedMid = "*".repeat(walletId.length - prefix.length - 2);

  return prefix + maskedMid + last2;
}

// 2025-11-10 / 09:51:10 AM style
function formatReceiptDateTime(date) {
  const d = date ? new Date(date) : new Date();

  const dateStr = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  return { dateStr, timeStr };
}

function normalizeBhutanPhone(phone) {
  const raw = String(phone || "").trim();
  if (!raw) return null;

  const digits = raw.replace(/[^\d]/g, "");

  // 8-digit local -> prefix 975
  if (digits.length === 8) return `975${digits}`;

  // already 975xxxxxxxx
  if (digits.length === 11 && digits.startsWith("975")) return digits;

  return digits || null;
}

async function sendOtpSms({
  to,
  otp,
  purposeTitle = "Verification code",
  ttlMinutes = 5,
}) {
  if (!SMS_API_KEY) {
    throw new Error("SMS_API_KEY missing in env");
  }

  if (!SMS_API_URL) {
    throw new Error("SMS_API_URL missing in env");
  }

  const text =
    `${purposeTitle}\n\n` +
    `${otp}\n\n` +
    `This code is valid for ${ttlMinutes} minutes.\n` +
    `Do not share this code with anyone.`;

  const resp = await fetch(SMS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SMS_API_KEY,
    },
    body: JSON.stringify({
      to,
      text,
      from: SMS_FROM,
    }),
  });

  const bodyText = await resp.text();

  if (!resp.ok) {
    throw new Error(`SMS gateway error ${resp.status}: ${bodyText}`);
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return {
      ok: true,
      response: bodyText,
    };
  }
}

/* ==========================
   EXPO PUSH
   Payload required:
   { user_id, title, body }
========================== */

async function sendExpoNotification({ user_id, title, body }) {
  if (!EXPO_NOTIFICATION_URL) {
    return {
      ok: false,
      skipped: true,
      reason: "EXPO_NOTIFICATION_URL missing",
    };
  }

  const uid = Number(user_id);

  if (!Number.isFinite(uid) || uid <= 0) {
    return {
      ok: false,
      skipped: true,
      reason: "Invalid user_id",
    };
  }

  const payload = {
    user_id: uid,
    title: String(title || "").trim() || "Notification",
    body: String(body || "").trim() || "",
  };

  try {
    const resp = await fetch(EXPO_NOTIFICATION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await resp.text();

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: text,
      };
    }

    try {
      return {
        ok: true,
        data: JSON.parse(text),
      };
    } catch {
      return {
        ok: true,
        data: text,
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: e.message,
    };
  }
}

function isValidWalletId(v) {
  return /^TD\d{8}$/i.test(String(v || "").trim());
}

function isValidStatus(v) {
  return ["ACTIVE", "INACTIVE"].includes(
    String(v || "")
      .trim()
      .toUpperCase(),
  );
}

function isValidUserId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

function normalizeBoolean(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}
async function safeWalletLogFromReq(req, payload) {
  try {
    await createWalletTransactionLog({
      request_id: req.request_id,
      ...payload,
      ip_address: req.ip,
      user_agent: req.headers["user-agent"],
    });
  } catch (err) {
    console.error("[wallet_transaction_logs] controller log failed:", {
      message: err.message,
      request_id: req.request_id,
      action: payload?.action,
      status: payload?.status,
    });
  }
}
/* ==========================
   CONTROLLERS
========================== */

/* ---------- CREATE ---------- */

async function create(req, res) {
  try {
    const { status = "ACTIVE" } = req.body || {};
    // The wallet is always created for the authenticated caller.
    // A client-supplied user_id must never be trusted (IDOR).
    const uid = Number(req.user?.user_id);

    if (!isValidUserId(uid)) {
      return res.status(401).json({
        success: false,
        message: "Invalid authenticated user.",
      });
    }

    const st = String(status).trim().toUpperCase();

    if (!isValidStatus(st)) {
      return res.status(400).json({
        success: false,
        message: "Status must be ACTIVE or INACTIVE.",
      });
    }

    const result = await createWallet({
      user_id: uid,
      status: st,
    });

    if (result?.error === "USER_NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (result?.error === "WALLET_EXISTS") {
      return res.status(409).json({
        success: false,
        message: "Wallet already exists for this user.",
        existing: sanitizeWallet(result.wallet),
      });
    }

    return res.json({
      success: true,
      message: "Wallet created.",
      data: sanitizeWallet(result),
    });
  } catch (e) {
    console.error("Error creating wallet:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- READ ALL ---------- */

async function getAll(req, res) {
  try {
    const { limit = 50, offset = 0, status = null } = req.query || {};

    const rows = await listWallets({
      limit,
      offset,
      status,
    });

    return res.json({
      success: true,
      count: rows.length,
      data: rows.map(sanitizeWallet),
    });
  } catch (e) {
    console.error("Error listing wallets:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- READ ONE (by wallet_id or id) ---------- */

async function getByIdParam(req, res) {
  try {
    const { wallet_id } = req.params;

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const callerId = Number(req.user?.user_id);
    const isOwner = callerId === Number(wallet.user_id);

    if (!isOwner && !isAdminRole(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this wallet.",
      });
    }

    return res.json({
      success: true,
      data: sanitizeWallet(wallet),
    });
  } catch (e) {
    console.error("Error getting wallet:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- READ ONE (by user_id) ---------- */

async function getByUserId(req, res) {
  try {
    const { user_id } = req.params;
    const uid = Number(user_id);

    if (!isValidUserId(uid)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id.",
      });
    }

    const callerId = Number(req.user?.user_id);

    if (callerId !== uid && !isAdminRole(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this wallet.",
      });
    }

    const wallet = await getWalletByUserId(uid);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found for this user.",
      });
    }

    return res.json({
      success: true,
      data: sanitizeWallet(wallet),
    });
  } catch (e) {
    console.error("Error getting wallet by user_id:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- HAS T-PIN (by user_id) ---------- */

async function checkTPinByUserId(req, res) {
  try {
    const { user_id } = req.params;
    const uid = Number(user_id);

    if (!isValidUserId(uid)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_id.",
      });
    }

    const callerId = Number(req.user?.user_id);

    if (callerId !== uid && !isAdminRole(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this wallet.",
      });
    }

    const wallet = await getWalletByUserId(uid);

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found for this user.",
      });
    }

    const hasTPin = !!wallet.t_pin && wallet.t_pin !== "";

    return res.json({
      success: true,
      user_id: uid,
      has_tpin: hasTPin,
    });
  } catch (e) {
    console.error("Error checking T-PIN:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- UPDATE STATUS ---------- */

async function updateStatusByParam(req, res) {
  try {
    const { wallet_id, status } = req.params;
    const st = String(status || "")
      .trim()
      .toUpperCase();

    if (!isValidStatus(st)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status.",
      });
    }

    const updated = await updateWalletStatus({
      key: wallet_id,
      status: st,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    return res.json({
      success: true,
      message: "Wallet status updated.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error updating wallet status:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- DELETE ---------- */

async function removeByParam(req, res) {
  try {
    const { wallet_id } = req.params;

    const out = await deleteWallet({
      key: wallet_id,
    });

    if (!out.ok && out.code === "NOT_FOUND") {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    if (!out.ok && out.code === "HAS_TRANSACTIONS") {
      return res.status(409).json({
        success: false,
        message: "Cannot delete wallet with transactions.",
      });
    }

    return res.json({
      success: true,
      message: "Wallet deleted.",
    });
  } catch (e) {
    console.error("Error deleting wallet:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- ADMIN TIP TRANSFER ---------- */

async function adminTipTransferHandler(req, res) {
  try {
    const {
      admin_name,
      admin_wallet_id,
      user_wallet_id,
      amount,
      note = "",
      t_pin,
    } = req.body || {};

    if (!admin_name || String(admin_name).trim().length < 2) {
      return res.status(400).json({
        success: false,
        message: "admin_name is required.",
      });
    }

    if (!isValidWalletId(admin_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid admin_wallet_id.",
      });
    }

    if (!isValidWalletId(user_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user_wallet_id.",
      });
    }

    if (String(admin_wallet_id) === String(user_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Wallets must differ.",
      });
    }

    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be positive (Nu).",
      });
    }

    const adminWallet = await getWallet({
      key: admin_wallet_id,
    });

    if (!adminWallet) {
      return res.status(404).json({
        success: false,
        message: "Admin wallet not found.",
      });
    }

    if (adminWallet.status !== "ACTIVE" || !adminWallet.t_pin) {
      return res.status(400).json({
        success: false,
        message: "Admin wallet is not active or does not have a T-PIN set.",
      });
    }

    const pinStr = String(t_pin || "").trim();

    if (!/^\d{4}$/.test(pinStr)) {
      return res.status(400).json({
        success: false,
        message: "T-PIN must be a 4-digit numeric code.",
      });
    }

    const isValidPin = await bcrypt.compare(pinStr, adminWallet.t_pin);

    if (!isValidPin) {
      await safeWalletLogFromReq(req, {
        wallet_id: admin_wallet_id,
        user_id: adminWallet.user_id,
        action: "ADMIN_TIP_TRANSFER",
        status: "FAILED",
        message: "Invalid admin T-PIN.",
        request_payload: {
          admin_name,
          admin_wallet_id,
          user_wallet_id,
          amount,
          note,
        },
      });

      return res.status(401).json({
        success: false,
        message: "Invalid T-PIN.",
      });
    }

    const result = await adminTipTransfer({
      admin_name: String(admin_name).trim(),
      admin_wallet_id,
      user_wallet_id,
      amount_nu: Number(amount),
      note,
    });

    if (!result.ok) {
      await safeWalletLogFromReq(req, {
        wallet_id: admin_wallet_id,
        user_id: adminWallet.user_id,
        action: "ADMIN_TIP_TRANSFER",
        status: "FAILED",
        message: result.message || "Admin tip transfer failed.",
        request_payload: {
          admin_name,
          admin_wallet_id,
          user_wallet_id,
          amount,
          note,
        },
        response_payload: result,
      });

      return res.status(result.status || 400).json({
        success: false,
        message: result.message,
      });
    }

    return res.json({
      success: true,
      message: "Tip transferred successfully.",
      data: result,
    });
  } catch (e) {
    console.error("Error in adminTipTransfer:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- SET / CREATE T-PIN ---------- */

async function setTPin(req, res) {
  try {
    const { wallet_id } = req.params;
    const { t_pin } = req.body || {};

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const pinStr = String(t_pin || "").trim();

    if (!/^\d{4}$/.test(pinStr)) {
      return res.status(400).json({
        success: false,
        message: "t_pin must be a 4-digit numeric code (e.g. 1234).",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    if (Number(req.user?.user_id) !== Number(wallet.user_id)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this wallet.",
      });
    }

    if (wallet.t_pin && wallet.t_pin !== "") {
      return res.status(409).json({
        success: false,
        message: "T-PIN already set. Use change endpoint to modify it.",
      });
    }

    const hashedPin = await bcrypt.hash(pinStr, 10);

    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashedPin,
    });

    if (!updated) {
      return res.status(500).json({
        success: false,
        message: "Failed to set T-PIN.",
      });
    }

    return res.json({
      success: true,
      message: "T-PIN set successfully.",
      data: sanitizeWallet(updated),
    });
  } catch (e) {
    console.error("Error setting T-PIN:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- CHANGE T-PIN ---------- */

async function changeTPin(req, res) {
  try {
    const { wallet_id } = req.params;
    const { old_t_pin, new_t_pin } = req.body || {};

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const oldPinStr = String(old_t_pin || "").trim();

    if (!/^\d{4}$/.test(oldPinStr)) {
      return res.status(400).json({
        success: false,
        message: "old_t_pin must be a 4-digit numeric code.",
      });
    }

    const newPinStr = String(new_t_pin || "").trim();

    if (!/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({
        success: false,
        message: "new_t_pin must be a 4-digit numeric code.",
      });
    }

    if (oldPinStr === newPinStr) {
      return res.status(400).json({
        success: false,
        message: "New T-PIN must be different from the old T-PIN.",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    if (Number(req.user?.user_id) !== Number(wallet.user_id)) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this wallet.",
      });
    }

    if (!wallet.t_pin) {
      return res.status(409).json({
        success: false,
        message: "T-PIN not set yet. Please set it first.",
      });
    }

    const isMatch = await bcrypt.compare(oldPinStr, wallet.t_pin);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Old T-PIN is incorrect.",
      });
    }

    const newHashed = await bcrypt.hash(newPinStr, 10);

    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: newHashed,
    });

    if (!updated) {
      return res.status(500).json({
        success: false,
        message: "Failed to update T-PIN.",
      });
    }

    return res.json({
      success: true,
      message: "T-PIN changed successfully.",
      data: sanitizeWallet(updated),
    });
  } catch (e) {
    console.error("Error changing T-PIN:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- FORGOT T-PIN: REQUEST OTP (EMAIL) ---------- */

async function forgotTPinRequest(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const user = await prisma.users.findUnique({
      where: {
        user_id: Number(wallet.user_id),
      },
      select: {
        user_id: true,
        email: true,
        user_name: true,
      },
    });

    if (!user || !user.email) {
      return res.status(404).json({
        success: false,
        message: "User email not found.",
      });
    }

    const email = String(user.email || "")
      .trim()
      .toLowerCase();
    const userName = user.user_name || null;

    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!isValidEmail) {
      return res.status(400).json({
        success: false,
        message: "Invalid email address for this user.",
      });
    }

    const rlKey = `tpin_reset_email_rl:${wallet.user_id}:${wallet.wallet_id}`;

    if (await redis.get(rlKey)) {
      return res.status(429).json({
        success: false,
        message: "Please wait before requesting another OTP.",
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const redisKey = `tpin_reset:${wallet.user_id}:${wallet.wallet_id}`;

    await redis.set(redisKey, otp, "EX", 300);
    await redis.set(rlKey, "1", "EX", 30);

    await sendOtpEmail({
      to: email,
      otp,
      userName,
      walletId: wallet.wallet_id,
    });
    await safeWalletLogFromReq(req, {
      wallet_id: wallet.wallet_id,
      user_id: wallet.user_id,
      action: "TPIN_RESET_EMAIL_OTP_REQUEST",
      status: "SUCCESS",
      message: "T-PIN reset email OTP sent.",
      request_payload: {
        wallet_id: wallet.wallet_id,
        email,
      },
    });
    return res.json({
      success: true,
      message:
        "OTP has been sent to your registered email address. It is valid for 5 minutes.",
    });
  } catch (e) {
    console.error("Error in forgotTPinRequest:", e);

    return res.status(500).json({
      success: false,
      message: "Failed to send OTP.",
      error: e?.message || String(e),
    });
  }
}

/* ---------- FORGOT T-PIN: VERIFY OTP (EMAIL) & SET NEW T-PIN ---------- */

async function forgotTPinVerify(req, res) {
  try {
    const { wallet_id } = req.params;
    const { otp, new_t_pin } = req.body || {};

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const otpStr = String(otp || "").trim();

    if (!/^\d{6}$/.test(otpStr)) {
      return res.status(400).json({
        success: false,
        message: "otp must be a 6-digit numeric code.",
      });
    }

    const newPinStr = String(new_t_pin || "").trim();

    if (!/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({
        success: false,
        message: "new_t_pin must be a 4-digit numeric code.",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const redisKey = `tpin_reset:${wallet.user_id}:${wallet.wallet_id}`;
    const savedOtp = await redis.get(redisKey);

    if (!savedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired or not found. Please request a new OTP.",
      });
    }

    if (String(savedOtp).trim() !== otpStr) {
      await safeWalletLogFromReq(req, {
        wallet_id: wallet.wallet_id,
        user_id: wallet.user_id,
        action: "TPIN_RESET_EMAIL_VERIFY",
        status: "FAILED",
        message: "Invalid email OTP.",
        request_payload: {
          wallet_id: wallet.wallet_id,
        },
      });

      return res.status(400).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    const hashed = await bcrypt.hash(newPinStr, 10);

    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashed,
    });

    await redis.del(redisKey);
    await safeWalletLogFromReq(req, {
      wallet_id: wallet.wallet_id,
      user_id: wallet.user_id,
      action: "TPIN_RESET_EMAIL_VERIFY",
      status: "SUCCESS",
      message: "T-PIN reset successfully using email OTP.",
      request_payload: {
        wallet_id: wallet.wallet_id,
      },
    });
    if (!updated) {
      return res.status(500).json({
        success: false,
        message: "Failed to update T-PIN.",
      });
    }

    return res.json({
      success: true,
      message: "T-PIN reset successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error in forgotTPinVerify:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* =========================================================
   FORGOT T-PIN (SMS): REQUEST OTP
   POST /wallet/:wallet_id/forgot-tpin-sms
========================================================= */

async function forgotTPinRequestSms(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const user = await prisma.users.findUnique({
      where: {
        user_id: Number(wallet.user_id),
      },
      select: {
        user_id: true,
        phone: true,
        user_name: true,
      },
    });

    if (!user || !user.phone) {
      return res.status(404).json({
        success: false,
        message: "User phone not found.",
      });
    }

    const phoneToSend = normalizeBhutanPhone(user.phone);

    if (!phoneToSend) {
      return res.status(400).json({
        success: false,
        message: "Invalid phone number format.",
      });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const redisKey = `tpin_reset_sms:${wallet.user_id}:${wallet.wallet_id}`;

    await redis.set(redisKey, otp, "EX", 300);

    await sendOtpSms({
      to: phoneToSend,
      otp,
      purposeTitle: "T-PIN reset code",
      ttlMinutes: 5,
    });
    await safeWalletLogFromReq(req, {
      wallet_id: wallet.wallet_id,
      user_id: wallet.user_id,
      action: "TPIN_RESET_SMS_OTP_REQUEST",
      status: "SUCCESS",
      message: "T-PIN reset SMS OTP sent.",
      request_payload: {
        wallet_id: wallet.wallet_id,
        phone: phoneToSend,
      },
    });
    return res.json({
      success: true,
      message:
        "OTP has been sent to your registered phone number. It is valid for 10 minutes.",
    });
  } catch (e) {
    console.error("Error in forgotTPinRequestSms:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* =========================================================
   FORGOT T-PIN (SMS): VERIFY OTP & SET NEW T-PIN
   POST /wallet/:wallet_id/forgot-tpin-sms/verify
   body: { otp, new_t_pin }
========================================================= */

async function forgotTPinVerifySms(req, res) {
  try {
    const { wallet_id } = req.params;
    const { otp, new_t_pin } = req.body || {};

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const otpStr = String(otp || "").trim();

    if (!/^\d{6}$/.test(otpStr)) {
      return res.status(400).json({
        success: false,
        message: "otp must be a 6-digit numeric code.",
      });
    }

    const newPinStr = String(new_t_pin || "").trim();

    if (!/^\d{4}$/.test(newPinStr)) {
      return res.status(400).json({
        success: false,
        message: "new_t_pin must be a 4-digit numeric code.",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const redisKey = `tpin_reset_sms:${wallet.user_id}:${wallet.wallet_id}`;
    const savedOtp = await redis.get(redisKey);

    if (!savedOtp) {
      return res.status(410).json({
        success: false,
        message: "OTP expired or not found. Please request a new OTP.",
      });
    }

    if (String(savedOtp).trim() !== otpStr) {
      await safeWalletLogFromReq(req, {
        wallet_id: wallet.wallet_id,
        user_id: wallet.user_id,
        action: "TPIN_RESET_SMS_VERIFY",
        status: "FAILED",
        message: "Invalid SMS OTP.",
        request_payload: {
          wallet_id: wallet.wallet_id,
        },
      });

      return res.status(400).json({
        success: false,
        message: "Invalid OTP.",
      });
    }

    const hashed = await bcrypt.hash(newPinStr, 10);

    const updated = await setWalletTPin({
      key: wallet_id,
      t_pin_hash: hashed,
    });

    await redis.del(redisKey);
    await safeWalletLogFromReq(req, {
      wallet_id: wallet.wallet_id,
      user_id: wallet.user_id,
      action: "TPIN_RESET_SMS_VERIFY",
      status: "SUCCESS",
      message: "T-PIN reset successfully using SMS OTP.",
      request_payload: {
        wallet_id: wallet.wallet_id,
      },
    });
    if (!updated) {
      return res.status(500).json({
        success: false,
        message: "Failed to update T-PIN.",
      });
    }

    return res.json({
      success: true,
      message: "T-PIN reset successfully.",
      data: mapLocalTimes(updated),
    });
  } catch (e) {
    console.error("Error in forgotTPinVerifySms:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- USER WALLET TRANSFER ---------- */

async function userTransfer(req, res) {
  try {
    const {
      sender_wallet_id,
      recipient_wallet_id,
      amount,
      note = "",
      t_pin,
      biometric = false,
    } = req.body || {};

    if (!isValidWalletId(sender_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sender_wallet_id.",
      });
    }

    if (!isValidWalletId(recipient_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid recipient_wallet_id.",
      });
    }

    if (String(sender_wallet_id) === String(recipient_wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Sender and recipient wallet must be different.",
      });
    }

    if (isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a positive number (Nu).",
      });
    }

    const biometricOk = normalizeBoolean(biometric);

    const senderWallet = await getWallet({
      key: sender_wallet_id,
    });

    if (!senderWallet) {
      return res.status(404).json({
        success: false,
        message: "Sender wallet not found.",
      });
    }

    if (Number(req.user?.user_id) !== Number(senderWallet.user_id)) {
      return res.status(403).json({
        success: false,
        message: "You can only transfer funds from your own wallet.",
      });
    }

    if (senderWallet.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Sender wallet is not ACTIVE.",
      });
    }

    if (!biometricOk) {
      const pinStr = String(t_pin || "").trim();

      if (!/^\d{4}$/.test(pinStr)) {
        return res.status(400).json({
          success: false,
          message: "t_pin must be a 4-digit numeric code.",
        });
      }

      if (!senderWallet.t_pin) {
        return res.status(409).json({
          success: false,
          message: "T-PIN not set for this wallet.",
        });
      }

      const okPin = await bcrypt.compare(pinStr, senderWallet.t_pin);

      if (!okPin) {
        await safeWalletLogFromReq(req, {
          wallet_id: sender_wallet_id,
          user_id: senderWallet.user_id,
          action: "USER_WALLET_TRANSFER",
          status: "FAILED",
          message: "Invalid T-PIN.",
          request_payload: {
            sender_wallet_id,
            recipient_wallet_id,
            amount,
            note,
            biometric,
          },
        });

        return res.status(401).json({
          success: false,
          message: "Invalid T-PIN.",
        });
      }
    }

    const recipientWallet = await getWallet({
      key: recipient_wallet_id,
    });

    if (!recipientWallet) {
      return res.status(404).json({
        success: false,
        message: "Recipient wallet not found.",
      });
    }

    if (recipientWallet.status !== "ACTIVE") {
      return res.status(403).json({
        success: false,
        message: "Recipient wallet is not ACTIVE.",
      });
    }

    const result = await userWalletTransfer({
      sender_wallet_id,
      recipient_wallet_id,
      amount_nu: Number(amount),
      note,
    });

    if (!result.ok) {
      await safeWalletLogFromReq(req, {
        wallet_id: sender_wallet_id,
        user_id: senderWallet.user_id,
        action: "USER_WALLET_TRANSFER",
        status: "FAILED",
        message: result.message || "Transfer failed.",
        request_payload: {
          sender_wallet_id,
          recipient_wallet_id,
          amount,
          note,
          biometric,
        },
        response_payload: result,
      });

      return res.status(result.status || 400).json({
        success: false,
        message: result.message || "Transfer failed.",
      });
    }

    const { journal_code, transaction_ids } = result;

    const primaryTxnId = Array.isArray(transaction_ids)
      ? transaction_ids[0]
      : null;

    const { dateStr, timeStr } = formatReceiptDateTime();

    const receipt = {
      amount: `Nu. ${Number(amount).toFixed(2)}`,
      journal_no: journal_code,
      transaction_id: primaryTxnId,
      from_account: maskWallet(sender_wallet_id),
      to_account: maskWallet(recipient_wallet_id),
      purpose: note || "N/A",
      date: dateStr,
      time: timeStr,
      biometric: biometricOk,
    };

    const amtStr = `Nu. ${Number(amount).toFixed(2)}`;
    const jrn = journal_code || "N/A";
    const tnx = primaryTxnId || "N/A";

    const senderTitle = "Wallet Transfer - Debited";
    const senderBody =
      `Amount: ${amtStr} (DEBITED)\n` +
      `Journal No: ${jrn}\n` +
      `Txn ID: ${tnx}\n` +
      `To: ${maskWallet(recipient_wallet_id)}` +
      (note ? `\nNote: ${note}` : "");

    const receiverTitle = "Wallet Transfer - Credited";
    const receiverBody =
      `Amount: ${amtStr} (CREDITED)\n` +
      `Journal No: ${jrn}\n` +
      `Txn ID: ${tnx}\n` +
      `From: ${maskWallet(sender_wallet_id)}` +
      (note ? `\nNote: ${note}` : "");

    Promise.allSettled([
      sendExpoNotification({
        user_id: senderWallet.user_id,
        title: senderTitle,
        body: senderBody,
      }),
      sendExpoNotification({
        user_id: recipientWallet.user_id,
        title: receiverTitle,
        body: receiverBody,
      }),
    ]).catch(() => {});

    return res.json({
      success: true,
      message: "Wallet transfer successful.",
      receipt,
    });
  } catch (e) {
    console.error("Error in userTransfer:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

/* ---------- GET USER_NAME BY WALLET_ID ---------- */

async function getUserNameByWalletId(req, res) {
  try {
    const { wallet_id } = req.params;

    if (!isValidWalletId(wallet_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid wallet_id.",
      });
    }

    const wallet = await getWallet({
      key: wallet_id,
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const user = await prisma.users.findUnique({
      where: {
        user_id: BigInt(wallet.user_id),
      },
      select: {
        user_id: true,
        user_name: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found for this wallet.",
      });
    }

    return res.json({
      success: true,
      data: {
        user_id: Number(user.user_id),
        user_name: user.user_name,
      },
    });
  } catch (e) {
    console.error("Error in getUserNameByWalletId:", e);

    return res.status(500).json({
      success: false,
      message: e.message,
    });
  }
}

module.exports = {
  create,
  getAll,
  getByIdParam,
  getByUserId,
  updateStatusByParam,
  removeByParam,
  adminTipTransfer: adminTipTransferHandler,
  setTPin,
  changeTPin,
  forgotTPinRequest,
  forgotTPinVerify,
  forgotTPinRequestSms,
  forgotTPinVerifySms,
  userTransfer,
  checkTPinByUserId,
  getUserNameByWalletId,
  requireAdmin,
};
