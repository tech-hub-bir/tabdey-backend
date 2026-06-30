// routes/orderRoutes.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const orderCtrl = require("../controllers/orderControllers");
const { uploadDeliveryPhotos } = require("../middleware/uploadDeliveryPhoto");

/* validators */
const validOrderId = (req, res, next) => {
  const id = String(req.params.order_id || "").trim();
  return id.startsWith("ORD-")
    ? next()
    : res.status(400).json({ message: "Invalid order_id" });
};

const validBizId = (req, res, next) => {
  const bid = Number(req.params.business_id);
  return Number.isFinite(bid) && bid > 0
    ? next()
    : res.status(400).json({ message: "Invalid business_id" });
};

const validUserId = (req, res, next) => {
  const uid = Number(req.params.user_id);
  return Number.isFinite(uid) && uid > 0
    ? next()
    : res.status(400).json({ message: "Invalid user_id" });
};

/**
 * multipart/form-data fields supported by uploadDeliveryPhotos():
 * - delivery_photo (single/multi)
 * - delivery_photos (multi)
 * - image (single/multi)
 * - images (multi)
 */

let rateLimiterOrder = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      success: false,
      message:
        "You can only make 10 order requests in an hour. Please try again later.",
    });
  },
});

router.post(
  "/orders",
  rateLimiterOrder,
  uploadDeliveryPhotos,
  orderCtrl.createOrder,
);

router.get("/orders/:order_id", validOrderId, orderCtrl.getOrderById);
router.put("/orders/:order_id", validOrderId, orderCtrl.updateOrder);
router.delete("/orders/:order_id", validOrderId, orderCtrl.deleteOrder);

router.put(
  "/orders/:order_id/status",
  validOrderId,
  orderCtrl.updateOrderStatus,
);

/* Business-scoped */
router.get(
  "/orders/business/:business_id",
  validBizId,
  orderCtrl.getOrdersByBusinessId,
);
router.get(
  "/orders/business/:business_id/grouped",
  validBizId,
  orderCtrl.getBusinessOrdersGroupedByUser,
);
router.get(
  "/orders/business/:business_id/status-counts",
  validBizId,
  orderCtrl.getOrderStatusCountsByBusiness,
);

/* User-facing */
router.get("/users/:user_id/orders", validUserId, orderCtrl.getOrdersForUser);

/* User cancels */
router.patch(
  "/users/:user_id/orders/:order_id/cancel",
  validUserId,
  validOrderId,
  orderCtrl.cancelOrderByUser,
);

module.exports = router;
