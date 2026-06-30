// routes/walletRoutes.js
const router = require("express").Router();
const ctrl = require("../controllers/walletController");

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

// CREATE WALLET
router.post("/create", rateLimiter, ctrl.create);

// READ (GET)
router.get("/getall", ctrl.getAll);
router.get("/getone/:wallet_id", ctrl.getByIdParam);

// ✅ NEW: get user_name by wallet_id
router.get("/:wallet_id/user-name", ctrl.getUserNameByWalletId);

router.get("/:wallet_id", ctrl.getByIdParam);
router.get("/getbyuser/:user_id", ctrl.getByUserId);

// UPDATE STATUS
router.put("/:wallet_id/:status", ctrl.updateStatusByParam);

// DELETE WALLET
router.delete("/delete/:wallet_id", ctrl.removeByParam);

// ✅ ADMIN TIP TRANSFER (Send Nu from admin wallet to another wallet)
router.post("/admin/tip", rateLimiter, ctrl.adminTipTransfer);

// ✅ SET / CREATE T-PIN for a wallet
router.post("/:wallet_id/t-pin", rateLimiter, ctrl.setTPin);

// CHANGE T-PIN (verify old T-PIN first)
router.patch("/:wallet_id/t-pin", rateLimiter, ctrl.changeTPin);

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

router.post("/transfer", rateLimiterTransfer, ctrl.userTransfer);

router.get("/:user_id/has-tpin", ctrl.checkTPinByUserId);

module.exports = router;
