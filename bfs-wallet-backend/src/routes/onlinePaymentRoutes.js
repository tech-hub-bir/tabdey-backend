const express = require("express");
const router = express.Router();
const {
  initPaymentHandler,
  accountEnquiryHandler,
  payHandler,
  statusHandler,
} = require("../controllers/onlinePaymentController");

/**
 * 1. Init payment (AR)
 * POST /api/payment/init
 * body: { amount, email, description }
 * return: { orderNo, bfsTxnId, bankList[] }
 */
router.post("/init", initPaymentHandler);

/**
 * 2. Account enquiry (AE)
 * POST /api/payment/account-enquiry
 * body: { orderNo, remitterBankId, remitterAccNo }
 * return: { status: "ACCOUNT_VERIFIED", ... }
 */
router.post("/account-enquiry", accountEnquiryHandler);

/**
 * 3. Pay with OTP (DR)
 * POST /api/payment/pay
 * body: { orderNo, otp }
 * return: { status: "SUCCESS" | "FAILED", code, message, amount }
 */
router.post("/pay", payHandler);

/**
 * 4. Status check (AS)
 * GET /api/payment/status/:orderNo
 * return: { status, code, message, from }
 */
router.get("/status/:orderNo", statusHandler);

module.exports = router;
