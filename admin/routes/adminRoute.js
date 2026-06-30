// routes/adminRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const adminController = require("../controllers/adminController");
const auth = require("../middleware/auth");
const ensureAdmin = require("../middleware/ensureAdmin");

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
  message: "Too many admin actions. Please try again later.",
});

const validateUserIdParam = (req, res, next) => {
  const id = Number(req.params.user_id);
  if (Number.isFinite(id) && id > 0) return next();
  return res.status(400).json({ success: false, message: "Invalid user_id" });
};

// Add this near your other GET routes
// router.get("/admins-prisma", adminController.getAllAdminsPrisma);

// Lists
router.get("/users", adminController.getAllNormalUsers);
router.get("/drivers", adminController.getAllDrivers);
router.get("/admins", adminController.getAllAdmins);
router.get("/merchants", adminController.getAllMerchantsWithDetails);
router.get("/organizers", adminController.getAllOrganizers);

// Mutations
router.post(
  "/deactivate/:user_id",
  adminWriteLimiter,
  validateUserIdParam,
  adminController.deactivateUser,
);
router.post(
  "/activate/:user_id",
  adminWriteLimiter,
  validateUserIdParam,
  adminController.activateUser,
);
router.delete(
  "/delete/:user_id",
  adminWriteLimiter,
  validateUserIdParam,
  adminController.deleteUser,
);

// Driver approval queue
router.get(
  "/drivers/pending",
  adminReadLimiter,
  auth,
  ensureAdmin,
  adminController.getPendingDrivers,
);
router.patch(
  "/drivers/:driver_id/approve",
  adminWriteLimiter,
  auth,
  ensureAdmin,
  adminController.approveDriver,
);

module.exports = router;
