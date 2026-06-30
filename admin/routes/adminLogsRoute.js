// routes/adminLogRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { getAdminLogs } = require("../controllers/adminLogsController");

const logsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message: "Too many requests. Please slow down.",
    }),
});

// GET /api/admin-logs
router.get("/", getAdminLogs);

module.exports = router;
