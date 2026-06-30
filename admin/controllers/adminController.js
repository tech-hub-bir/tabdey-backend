const adminModel = require("../models/adminModel");
const { sendNotificationSmsBulk } = require("../services/smsNotificationService");

// helpers to extract acting admin for logs
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getActor(req) {
  return {
    user_id:
      toIntOrNull(req.user?.user_id) ??
      toIntOrNull(req.headers["x-admin-id"]) ??
      toIntOrNull(req.body?.user_id) ??
      null,
    admin_name:
      req.user?.admin_name ??
      req.headers["x-admin-name"] ??
      req.body?.admin_name ??
      null,
  };
}

// Users (role='user')
exports.getAllNormalUsers = async (_req, res) => {
  try {
    const users = await adminModel.fetchUsersByRole();
    res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Drivers (with license + vehicles)
exports.getAllDrivers = async (_req, res) => {
  try {
    const drivers = await adminModel.fetchDrivers();
    res.status(200).json({
      success: true,
      count: drivers.length,
      data: drivers,
    });
  } catch (error) {
    console.error("Error fetching drivers:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Admins list
exports.getAllAdmins = async (_req, res) => {
  try {
    const admins = await adminModel.fetchAdmins();
    res.status(200).json({
      success: true,
      count: admins.length,
      data: admins,
    });
  } catch (error) {
    console.error("Error fetching admins:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// Merchants
exports.getAllMerchantsWithDetails = async (_req, res) => {
  try {
    const merchants = await adminModel.fetchMerchantsWithBusiness();
    return res.status(200).json({
      success: true,
      count: merchants.length,
      data: merchants,
    });
  } catch (error) {
    console.error("Error fetching merchants:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};

// ===== activate/deactivate/delete =====
exports.deactivateUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const actor = getActor(req);
    const result = await adminModel.deactivateUser(
      user_id,
      actor.user_id,
      actor.admin_name,
    );

    if (result.notFound)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    if (result.already === "deactivated")
      return res
        .status(200)
        .json({ success: true, message: "Already deactivated" });

    return res.status(200).json({ success: true, message: "User deactivated" });
  } catch (error) {
    console.error("Deactivate error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};

exports.activateUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const actor = getActor(req);
    const result = await adminModel.activateUser(
      user_id,
      actor.user_id,
      actor.admin_name,
    );

    if (result.notFound)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    if (result.already === "active")
      return res.status(200).json({ success: true, message: "Already active" });

    return res.status(200).json({ success: true, message: "User activated" });
  } catch (error) {
    console.error("Activate error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const actor = getActor(req);
    const result = await adminModel.deleteUser(
      user_id,
      actor.user_id,
      actor.admin_name,
    );

    if (result.notFound)
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    return res.status(200).json({ success: true, message: "User deleted" });
  } catch (error) {
    if (error && error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({
        success: false,
        error: "Cannot delete user due to linked records.",
      });
    }
    console.error("Delete error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Internal Server Error" });
  }
};
// Organizers list
exports.getAllOrganizers = async (_req, res) => {
  try {
    const organizers = await adminModel.fetchOrganizers();
    res.status(200).json({
      success: true,
      count: organizers.length,
      data: organizers,
    });
  } catch (error) {
    console.error("Error fetching organizers:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// ===== Driver approval =====

// GET /api/admin/drivers/pending
exports.getPendingDrivers = async (_req, res) => {
  try {
    const drivers = await adminModel.fetchPendingDrivers();
    return res.status(200).json({
      success: true,
      count: drivers.length,
      data: drivers,
    });
  } catch (error) {
    console.error("Error fetching pending drivers:", error);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// PATCH /api/admin/drivers/:driver_id/approve
exports.approveDriver = async (req, res) => {
  try {
    const driver_id = Number(req.params.driver_id);
    if (!Number.isInteger(driver_id) || driver_id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid driver_id" });
    }

    const { action, rejection_reason } = req.body || {};

    if (action !== "approved" && action !== "rejected") {
      return res.status(400).json({
        success: false,
        message: 'action must be "approved" or "rejected"',
      });
    }

    if (action === "rejected" && !rejection_reason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "rejection_reason is required when rejecting a driver",
      });
    }

    const actor = getActor(req);
    const result = await adminModel.setDriverApproval(
      driver_id,
      action,
      rejection_reason,
      actor.user_id,
      actor.admin_name,
    );

    if (result.notFound) {
      return res.status(404).json({ success: false, message: "Driver not found" });
    }

    // Send SMS notification to driver (non-blocking)
    if (result.phone) {
      const smsText = action === "approved"
        ? `Hi ${result.driver_name || "Driver"}, your TàbDey driver registration has been approved! You can now log in and start accepting rides.`
        : `Hi ${result.driver_name || "Driver"}, your TàbDey driver registration was not approved. Reason: ${rejection_reason}. Please contact support for more information.`;

      sendNotificationSmsBulk({
        title: action === "approved" ? "Registration Approved" : "Registration Not Approved",
        message: smsText,
        recipients: [result.phone],
      }).catch((err) => console.error("SMS send error:", err?.message));
    }

    return res.status(200).json({
      success: true,
      message: action === "approved"
        ? "Driver approved. They can now log in."
        : "Driver rejected.",
      approval_status: result.approval_status,
    });
  } catch (error) {
    console.error("Approve driver error:", error);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};
