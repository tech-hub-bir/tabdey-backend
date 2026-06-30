const express = require("express");
const C = require("../controllers/withdrawals.controller");
const { requireUserAuth, requireAdminAuth } = require("../middleware/auth");

const router = express.Router();

/* USER (protected) */
router.post("/wallet/withdrawals", requireUserAuth, C.createWithdrawal);
router.get("/wallet/withdrawals", requireUserAuth, C.listMyWithdrawals);
router.post("/wallet/withdrawals/:id/cancel", requireUserAuth, C.cancelWithdrawal);

/* ADMIN (protected) */
router.get("/admin/withdrawals", requireAdminAuth, C.adminList);
router.post("/admin/withdrawals/:id/needs-info", requireAdminAuth, C.adminNeedsInfoOne);
router.post("/admin/withdrawals/:id/approve", requireAdminAuth, C.adminApproveOne);
router.post("/admin/withdrawals/:id/reject", requireAdminAuth, C.adminRejectOne);
router.post("/admin/withdrawals/:id/mark-paid", requireAdminAuth, C.adminMarkPaidOne);
router.post("/admin/withdrawals/:id/fail", requireAdminAuth, C.adminFailOne);

module.exports = router;