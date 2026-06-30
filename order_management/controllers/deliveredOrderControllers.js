// controllers/deliveredOrderControllers.js
const Delivered = require("../models/deliveredOrderModels");

exports.listDeliveredOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const limit = req.query?.limit;
    const offset = req.query?.offset;

    const data = await Delivered.getDeliveredOrdersByUser(userId, {
      limit,
      offset,
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[listDeliveredOrders]", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

exports.deleteDeliveredOrder = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const orderId = String(req.params.order_id || "").trim();

    const out = await Delivered.deleteDeliveredOrderByUser(userId, orderId);

    if (!out.deleted) {
      return res.status(404).json({
        success: false,
        message: "Delivered order not found for this user.",
      });
    }

    return res.json({
      success: true,
      message: "Delivered order deleted (items deleted too).",
      deleted: out.deleted,
    });
  } catch (err) {
    console.error("[deleteDeliveredOrder]", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

exports.deleteManyDeliveredOrders = async (req, res) => {
  try {
    const userId = Number(req.params.user_id);
    const order_ids = req.body?.order_ids;

    if (!Array.isArray(order_ids) || !order_ids.length) {
      return res.status(400).json({
        success: false,
        message: "order_ids must be a non-empty array.",
      });
    }

    const out = await Delivered.deleteManyDeliveredOrdersByUser(
      userId,
      order_ids
    );

    return res.json({
      success: true,
      message: "Delivered orders deleted (items deleted too).",
      deleted: out.deleted,
    });
  } catch (err) {
    console.error("[deleteManyDeliveredOrders]", err);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};
