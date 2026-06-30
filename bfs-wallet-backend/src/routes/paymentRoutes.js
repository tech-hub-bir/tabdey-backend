const express = require("express");
const router = express.Router();
const {
  initTopupHandler,
  accountEnquiryHandler,
  debitWithOtpHandler,
  statusHandler,
} = require("../controllers/paymentController");

/**
 * 1️⃣ Start topup (AR)
 * POST /api/wallet/topup/init
 * body: { userId, amount, email, description }
 * return: { orderNo, bfsTxnId, bankList[] }
 */
router.post("/init", initTopupHandler);

/**
 * 2️⃣ Account enquiry (AE)
 * POST /api/wallet/topup/account-enquiry
 * body: { orderNo, remitterBankId, remitterAccNo }
 * return: { status: "ACCOUNT_VERIFIED", ... }
 */
router.post("/account-enquiry", accountEnquiryHandler);

/**
 * 3️⃣ Debit with OTP (DR)
 * POST /api/wallet/topup/debit
 * body: { orderNo, otp }
 * return: { status: "SUCCESS" | "FAILED", code, message, amount }
 */
router.post("/debit", debitWithOtpHandler);

/**
 * 4️⃣ Status check (AS)
 * GET /api/wallet/topup/status/:orderNo
 * return: { status, code, message, from }
 */
router.get("/status/:orderNo", statusHandler);

module.exports = router;
