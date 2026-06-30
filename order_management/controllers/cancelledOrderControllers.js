const Cancelled = require("../models/cancelledOrderModels");

async function getCancelledOrdersByUser(req, res) {
  try {
    const user_id = Number(req.params.user_id);
    const limit = req.query?.limit;
    const offset = req.query?.offset;

    const out = await Cancelled.getCancelledOrdersByUser(user_id, {
      limit,
      offset,
    });

    return res.json({
      success: true,
      pagination: {
        total: out.total,
        limit: out.limit,
        offset: out.offset,
        has_more: out.offset + out.limit < out.total,
      },
      data: out.rows,
    });
  } catch (err) {
    console.error("[getCancelledOrdersByUser] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function deleteCancelledOrder(req, res) {
  try {
    const user_id = Number(req.params.user_id);
    const order_id = String(req.params.order_id);

    const out = await Cancelled.deleteCancelledOrderByUser(user_id, order_id);

    if (!out.deleted) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    return res.json({ success: true, message: "Deleted", order_id });
  } catch (err) {
    if (err?.code === "P2034" || err?.code === "P2028" || err?.message?.includes("lock")) {
      return res.status(409).json({
        success: false,
        code: "ROW_LOCKED",
        message: "This cancelled order is busy (locked). Try again.",
      });
    }
    console.error("[deleteCancelledOrder] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

async function deleteManyCancelledOrders(req, res) {
  try {
    console.log("[deleteManyCancelledOrders] Body:", req.body);
    const user_id = Number(req.params.user_id);
    const body = req.body || {};
    const order_ids = Array.isArray(body.order_ids) ? body.order_ids : [];

    const out = await Cancelled.deleteManyCancelledOrdersByUser(user_id, order_ids);

    if (!out.ok && out.code === "EMPTY_LIST") {
      return res.status(400).json({
        success: false,
        message: "order_ids is required and must be a non-empty array",
      });
    }

    return res.json({
      success: true,
      message: "Cancelled orders deleted",
      deleted: out.deleted || 0,
    });
  } catch (err) {
    console.error("[deleteManyCancelledOrders] Error:", err);
    if (err?.code === "P2034" || err?.message?.includes("lock")) {
      return res.status(409).json({
        success: false,
        code: "LOCK_WAIT_TIMEOUT",
        message: "Delete is busy (row locked). Try again in a moment.",
      });
    }
    if (err?.code === "P2028" || err?.message?.includes("deadlock")) {
      return res.status(409).json({
        success: false,
        code: "DEADLOCK",
        message: "Deadlock occurred. Try again.",
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getCancelledOrdersByUser,
  deleteCancelledOrder,
  deleteManyCancelledOrders,
};