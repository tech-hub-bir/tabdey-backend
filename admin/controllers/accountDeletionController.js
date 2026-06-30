const model = require("../models/accountDeletionModel");

// POST /api/user/account-deletion
// Self-service: deletes the caller's own users row by their own user_id
// (from their access token), immediately. No admin review gate — App Store
// guideline 5.1.1(v) only permits requiring customer service to complete
// deletion for highly-regulated industries.
exports.submitRequest = async (req, res) => {
  const user_id = req.user?.user_id || req.user?.id;
  if (!user_id) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  try {
    const result = await model.selfDeleteAccount(user_id);

    return res.status(200).json({
      success: true,
      message: "Your account has been permanently deleted.",
      data: {
        deleted_user_id: result.user_id,
        resolved_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[accountDeletion] submitRequest error:", err);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// GET /api/user/account-deletion
exports.getMyRequest = async (req, res) => {
  const user_id = req.user?.user_id || req.user?.id;
  if (!user_id) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  try {
    const record = await model.getLatestByUser(user_id);
    return res.status(200).json({
      success: true,
      data: record
        ? {
            request_id: Number(record.request_id),
            status: record.status,
            requested_at: record.requested_at,
            resolved_at: record.resolved_at,
            reject_note: record.reject_note,
          }
        : null,
    });
  } catch (err) {
    console.error("[accountDeletion] getMyRequest error:", err);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// GET /api/admin/account-deletion-requests
exports.listRequests = async (req, res) => {
  try {
    const VALID_STATUSES = ["pending", "approved", "rejected", "all"];
    const status = VALID_STATUSES.includes(req.query.status)
      ? req.query.status
      : "pending";

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const result = await model.listRequests({ status, page, limit });

    return res.status(200).json({
      success: true,
      total: result.total,
      page,
      limit,
      data: result.data,
    });
  } catch (err) {
    console.error("[accountDeletion] listRequests error:", err);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// POST /api/admin/account-deletion-requests/:request_id/approve
exports.approveRequest = async (req, res) => {
  const request_id = Number(req.params.request_id);
  if (!Number.isFinite(request_id) || request_id <= 0) {
    return res.status(400).json({ success: false, error: "Invalid request_id." });
  }

  const adminUserId = req.admin?.user_id ?? req.user?.user_id ?? null;

  try {
    const result = await model.approveAndDeleteUser(request_id, adminUserId);

    if (result.notFound) {
      return res.status(404).json({ success: false, error: "Deletion request not found." });
    }
    if (result.alreadyResolved) {
      return res.status(400).json({
        success: false,
        error: "This request has already been resolved.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User account and all associated data have been permanently deleted.",
      data: {
        request_id,
        deleted_user_id: result.user_id,
        resolved_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("[accountDeletion] approveRequest error:", err);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};

// POST /api/admin/account-deletion-requests/:request_id/reject
exports.rejectRequest = async (req, res) => {
  const request_id = Number(req.params.request_id);
  if (!Number.isFinite(request_id) || request_id <= 0) {
    return res.status(400).json({ success: false, error: "Invalid request_id." });
  }

  const reject_note = req.body?.reject_note?.trim();
  if (!reject_note) {
    return res.status(400).json({ success: false, error: "reject_note is required." });
  }

  const adminUserId = req.admin?.user_id ?? req.user?.user_id ?? null;

  try {
    const result = await model.rejectRequest(
      request_id,
      adminUserId,
      reject_note.slice(0, 500),
    );

    if (result.notFound) {
      return res.status(404).json({ success: false, error: "Deletion request not found." });
    }
    if (result.alreadyResolved) {
      return res.status(400).json({
        success: false,
        error: "This request has already been resolved.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Deletion request rejected.",
      data: {
        request_id: Number(result.data.request_id),
        status: result.data.status,
        reject_note: result.data.reject_note,
        resolved_at: result.data.resolved_at,
      },
    });
  } catch (err) {
    console.error("[accountDeletion] rejectRequest error:", err);
    return res.status(500).json({ success: false, error: "Internal Server Error" });
  }
};
