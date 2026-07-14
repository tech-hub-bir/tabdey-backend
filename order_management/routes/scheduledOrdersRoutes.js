// routes/scheduledOrdersRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");

const {
  scheduleOrder,
  listScheduledOrders,
  cancelScheduledOrder,
  listScheduledOrdersByBusiness,
  updateScheduledOrderStatus,
} = require("../controllers/scheduledOrdersController");

const { uploadDeliveryPhotos } = require("../middleware/uploadDeliveryPhoto");
const authUser = require("../middleware/authUser");
const { requireSelfOrAdmin } = require("../middleware/authUser");

const rateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      message:
        "Too many scheduled order requests from this IP, please try again after some time.",
    });
  },
});

router.post(
  "/scheduled-orders",
  authUser,
  uploadDeliveryPhotos,
  scheduleOrder,
);

// FETCH all scheduled orders for a user
router.get(
  "/scheduled-orders/:user_id",
  authUser,
  requireSelfOrAdmin("user_id"),
  listScheduledOrders,
);

// FETCH all scheduled orders for a business
// e.g. /api/scheduled-orders/business/123
// Ownership (merchant owns this business, or admin) is verified in the controller.
router.get(
  "/scheduled-orders/business/:businessId",
  authUser,
  listScheduledOrdersByBusiness,
);

// CANCEL one scheduled order
router.delete(
  "/scheduled-orders/:user_id/:jobId",
  authUser,
  requireSelfOrAdmin("user_id"),
  cancelScheduledOrder,
);

// ACCEPT scheduled order
router.patch(
  "/scheduled-orders/:jobId/accept",
  authUser,
  updateScheduledOrderStatus,
);

// REJECT scheduled order
router.patch(
  "/scheduled-orders/:jobId/reject",
  authUser,
  updateScheduledOrderStatus,
);
module.exports = router;
