const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const authUser = require("../middleware/auth");

const {
  create,
  list,
  getOne,
  update,
  remove,
} = require("../controllers/adminCollaboratorController");

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const writeLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many requests. Please try again later.",
});

// Public routes (no auth required)
router.get("/", list);
router.get("/:id", getOne);

// Protected routes (require admin authentication)
router.post("/", authUser, writeLimiter, create);
router.put("/:id", authUser, writeLimiter, update);
router.delete("/:id", authUser, writeLimiter, remove);

module.exports = router;
