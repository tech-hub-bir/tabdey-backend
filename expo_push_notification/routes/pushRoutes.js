const express = require("express");
const router = express.Router();
const push = require("../controllers/pushController");

// ✅ Send to a single user_id
router.post("/send", push.sendToUser);

// ✅ Bulk send to many users
router.post("/send-bulk", push.sendBulkToUsers);

// ✅ Register push token
router.post("/register-token", push.registerToken);

// ✅ Remove push token
router.delete("/token", push.removeToken);

// ✅ Get user's push tokens
router.get("/tokens/:user_id", push.getUserTokens);

// ✅ Get notification history
router.get("/history/:user_id", push.getNotificationHistory);

module.exports = router;
