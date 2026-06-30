// routes/pointSystemRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const pointSystemController = require("../controllers/pointSystemController");
const adminOnly = require("../middleware/adminAuth");

const makeLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, message }),
  });

const adminReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many requests. Please slow down.",
});

const adminWriteLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: "Too many admin changes. Please try again later.",
});

/* POINT EARNING RULES */
router.get("/point-system", adminOnly, pointSystemController.getAllPointRules);

router.get(
  "/point-system/:id",
  adminOnly,
  pointSystemController.getPointRuleById,
);

router.post(
  "/point-system",
  adminOnly,
  adminWriteLimiter,
  pointSystemController.createPointRule,
);

router.put(
  "/point-system/:id",
  adminOnly,
  adminWriteLimiter,
  pointSystemController.updatePointRule,
);

router.delete(
  "/point-system/:id",
  adminOnly,
  adminWriteLimiter,
  pointSystemController.deletePointRule,
);

/* POINT CONVERSION RULE */
router.get(
  "/point-conversion-rule",
  adminOnly,
  pointSystemController.getPointConversionRule,
);

router.post(
  "/point-conversion-rule",
  adminOnly,
  adminWriteLimiter,
  pointSystemController.createPointConversionRule,
);

router.put(
  "/point-conversion-rule",
  adminOnly,
  adminWriteLimiter,
  pointSystemController.updatePointConversionRule,
);

router.delete(
  "/point-conversion-rule",
  adminOnly,
  adminWriteLimiter,
  pointSystemController.deletePointConversionRule,
);

module.exports = router;
