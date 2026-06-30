// src/routes/rmaLogRoutes.js
const express = require("express");
const router = express.Router();

const {
  listRmaLogs,
  getRmaLog,
} = require("../controllers/rmaLogController");

// List logs with filters
// GET /api/rma/logs?orderNo=...&bfsTxnId=...&tag=AR-RC&page=1&limit=50
router.get("/logs", listRmaLogs);

// Get single log by id
// GET /api/rma/logs/123
router.get("/logs/:id", getRmaLog);

module.exports = router;
