// routes/walletTransactionLogRoutes.js
const router = require("express").Router();
const rateLimit = require("express-rate-limit");

const ctrl = require("../controllers/walletTransactionLogController");

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message: "Too many log requests. Please slow down.",
    }),
});

router.get("/", readLimiter, ctrl.getAll);
router.get("/transaction/:transaction_id", readLimiter, ctrl.getByTransactionId);
router.get("/request/:request_id", readLimiter, ctrl.getByRequestId);

module.exports = router;