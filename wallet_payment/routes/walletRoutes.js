// routes/walletRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/walletController");
const authUser = require("../middleware/authUser");
const { requireAdmin } = require("../controllers/walletController");

const rateLimit = require("express-rate-limit");
const rateLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message:
        "Too many requests from this IP, please try again after a minute.",
    }),
});

const rateLimiterTransfer = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message:
        "You can only make 30 transfer requests in 24 hours. Please try again later.",
    }),
});

// CREATE WALLET (always for the authenticated caller — user_id is never trusted from the body)
router.post("/create", authUser, rateLimiter, ctrl.create);

// READ (GET) — admin-only listing / lookup by internal id
router.get("/getall", authUser, requireAdmin, ctrl.getAll);
router.get("/getone/:wallet_id", authUser, ctrl.getByIdParam);

// ✅ get user_name by wallet_id (needed to show recipient name before a transfer)
router.get("/:wallet_id/user-name", authUser, ctrl.getUserNameByWalletId);

router.get("/:wallet_id", authUser, ctrl.getByIdParam);
router.get("/getbyuser/:user_id", authUser, ctrl.getByUserId);

// UPDATE STATUS — admin only
router.put("/:wallet_id/:status", authUser, requireAdmin, ctrl.updateStatusByParam);

// DELETE WALLET — admin only
router.delete("/delete/:wallet_id", authUser, requireAdmin, ctrl.removeByParam);

// ✅ ADMIN TIP TRANSFER (Send Nu from admin wallet to another wallet)
router.post("/admin/tip", authUser, requireAdmin, rateLimiter, ctrl.adminTipTransfer);

// ✅ SET / CREATE T-PIN for a wallet (caller must own the wallet)
router.post("/:wallet_id/t-pin", authUser, rateLimiter, ctrl.setTPin);

// CHANGE T-PIN (verify old T-PIN first, caller must own the wallet)
router.patch("/:wallet_id/t-pin", authUser, rateLimiter, ctrl.changeTPin);

// ✅ FORGOT T-PIN: request OTP (send mail)
router.post("/:wallet_id/forgot-tpin", rateLimiter, ctrl.forgotTPinRequest);

// ✅ FORGOT T-PIN: verify OTP and set new T-PIN
router.post(
  "/:wallet_id/forgot-tpin/verify",
  rateLimiter,
  ctrl.forgotTPinVerify,
);

// ✅ NEW: FORGOT T-PIN via SMS (send OTP)
router.post(
  "/:wallet_id/forgot-tpin-sms",
  rateLimiter,
  ctrl.forgotTPinRequestSms,
);

// ✅ NEW: FORGOT T-PIN via SMS (verify OTP + set new T-PIN)
router.post(
  "/:wallet_id/forgot-tpin-sms/verify",
  rateLimiter,
  ctrl.forgotTPinVerifySms,
);

router.post("/transfer", authUser, rateLimiterTransfer, ctrl.userTransfer);

router.get("/:user_id/has-tpin", authUser, ctrl.checkTPinByUserId);

module.exports = router;
