const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const authUser = require("../middleware/auth");
const controller = require("../controllers/contactMessageController");
const { sendEmailController } = require("../controllers/emailController");

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const readLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many requests. Please slow down.",
});

const writeLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many requests. Please try again later.",
});

/* =======================================================
   PUBLIC ROUTES (No auth required)
======================================================= */

// Create contact message (public)
router.post("/", writeLimiter, controller.createMessage);

// Send email (public)
router.post("/send-email", writeLimiter, sendEmailController);

/* =======================================================
   ADMIN ROUTES (Bearer token required)
======================================================= */

// Get all messages (admin only)
router.get("/", authUser, readLimiter, controller.getAllMessages);

// Get single message (admin only)
router.get("/:id", authUser, readLimiter, controller.getMessageById);

// Update status (admin only)
router.patch("/:id/status", authUser, writeLimiter, controller.updateStatus);

// Delete message (admin only)
router.delete("/:id", authUser, writeLimiter, controller.deleteMessage);

module.exports = router;
