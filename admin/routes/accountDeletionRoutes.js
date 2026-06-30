const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const ctrl = require("../controllers/accountDeletionController");
const auth = require("../middleware/auth");
const ensureAdmin = require("../middleware/ensureAdmin");

const deletionRequestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({
      success: false,
      message: "Too many deletion requests. Please try again later.",
    }),
});

const adminWriteLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json({ success: false, message: "Too many admin actions. Please try again later." }),
});

// ── User-facing ──────────────────────────────────────────────────────────────

// POST /api/user/account-deletion
router.post("/account-deletion", auth, deletionRequestLimiter, ctrl.submitRequest);

// GET /api/user/account-deletion
router.get("/account-deletion", auth, ctrl.getMyRequest);

// ── Admin-facing ─────────────────────────────────────────────────────────────

// GET /api/admin/account-deletion-requests
router.get("/account-deletion-requests", auth, ensureAdmin, ctrl.listRequests);

// POST /api/admin/account-deletion-requests/:request_id/approve
router.post(
  "/account-deletion-requests/:request_id/approve",
  adminWriteLimiter,
  auth,
  ensureAdmin,
  ctrl.approveRequest,
);

// POST /api/admin/account-deletion-requests/:request_id/reject
router.post(
  "/account-deletion-requests/:request_id/reject",
  adminWriteLimiter,
  auth,
  ensureAdmin,
  ctrl.rejectRequest,
);

module.exports = router;
