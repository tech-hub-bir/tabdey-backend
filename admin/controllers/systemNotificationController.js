const { prisma } = require("../lib/prisma.js");
const {
  insertSystemNotification,
  getAllSystemNotifications,
  getNotificationsForUserRole,
  getUserContactById,
} = require("../models/systemNotificationModel");

const adminLogModel = require("../models/adminlogModel");
const {
  sendNotificationEmails,
} = require("../services/emailNotificationService");
const {
  sendNotificationSmsBulk,
} = require("../services/smsNotificationService");

// Redis log model (unchanged)
const {
  createDeliveryLog,
  listSingleUserLogsByTargetUserId,
} = require("../models/notificationDeliveryLogModel");

/* -------------------- helpers -------------------- */
function validateTitleMessage(title, message) {
  if (!title || !String(title).trim() || !message || !String(message).trim()) {
    return "Title and message are required.";
  }
  return null;
}

function pickActor(body = {}) {
  return {
    createdBy: body.user_id || null,
    adminName: body.user_name || "System",
  };
}

/* ======================================================
   Send EMAIL to SINGLE user
====================================================== */
async function sendEmailToSingleUser(req, res) {
  try {
    const { target_user_id, title, message } = req.body || {};
    const { createdBy, adminName } = pickActor(req.body || {});

    if (!target_user_id) {
      return res
        .status(400)
        .json({ success: false, message: "target_user_id is required." });
    }

    const err = validateTitleMessage(title, message);
    if (err) return res.status(400).json({ success: false, message: err });

    const user = await getUserContactById(target_user_id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Target user not found." });
    }

    const email = String(user.email || "").trim();
    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Target user email not found." });
    }

    const safeTitle = String(title).trim();
    const safeMessage = String(message).trim();

    const emailSummary = await sendNotificationEmails({
      notificationId: null,
      title: safeTitle,
      message: safeMessage,
      roles: [],
      recipients: [email],
    });

    const sent = Number(emailSummary?.sent || 0);
    const skipped = Number(emailSummary?.skipped || 0);

    const status = sent > 0 ? "sent" : skipped > 0 ? "skipped" : "failed";
    const reason =
      (Array.isArray(emailSummary?.failures) &&
        emailSummary.failures[0]?.reason) ||
      "";

    await createDeliveryLog({
      channel: "email",
      target_user_id: Number(target_user_id),
      target: email,
      title: safeTitle,
      message: safeMessage,
      status,
      reason,
      created_by: createdBy,
      admin_name: adminName,
      notification_id: null,
      context: "single",
      roles: [],
    });

    await adminLogModel.addLog({
      user_id: createdBy,
      admin_name: adminName,
      activity: `Sent EMAIL (single user) to user_id=${target_user_id} (${email}) — "${safeTitle}"`,
    });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully.",
      target_user_id: Number(target_user_id),
      email,
      email_summary: emailSummary,
    });
  } catch (err) {
    console.error("Send email error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   Send SMS to SINGLE user
====================================================== */
async function sendSmsToSingleUser(req, res) {
  try {
    const { target_user_id, title, message } = req.body || {};
    const { createdBy, adminName } = pickActor(req.body || {});

    if (!target_user_id) {
      return res
        .status(400)
        .json({ success: false, message: "target_user_id is required." });
    }

    const err = validateTitleMessage(title, message);
    if (err) return res.status(400).json({ success: false, message: err });

    const user = await getUserContactById(target_user_id);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "Target user not found." });
    }

    const phone = String(user.phone || "").trim();
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Target user phone number not found.",
      });
    }

    const safeTitle = String(title).trim();
    const safeMessage = String(message).trim();

    const smsSummary = await sendNotificationSmsBulk({
      title: safeTitle,
      message: safeMessage,
      roles: [],
      recipients: [phone],
    });

    const sent = Number(smsSummary?.sent || 0);
    const failed = Number(smsSummary?.failed || 0);
    const status = sent > 0 ? "sent" : failed > 0 ? "failed" : "sent";

    await createDeliveryLog({
      channel: "sms",
      target_user_id: Number(target_user_id),
      target: phone,
      title: safeTitle,
      message: safeMessage,
      status,
      reason: failed > 0 ? "SMS gateway returned failure" : "",
      created_by: createdBy,
      admin_name: adminName,
      notification_id: null,
      context: "single",
      roles: [],
    });

    await adminLogModel.addLog({
      user_id: createdBy,
      admin_name: adminName,
      activity: `Sent SMS (single user) to user_id=${target_user_id} (${phone}) — "${safeTitle}"`,
    });

    return res.status(200).json({
      success: true,
      message: "SMS sent successfully.",
      target_user_id: Number(target_user_id),
      phone,
      sms_summary: smsSummary,
    });
  } catch (err) {
    console.error("Send SMS error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   Fetch single-user delivery logs by target_user_id
====================================================== */
async function getSingleUserDeliveryLogsByUserIdController(req, res) {
  try {
    const { target_user_id } = req.params;
    const { page, limit } = req.query || {};

    const out = await listSingleUserLogsByTargetUserId({
      target_user_id: Number(target_user_id),
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      data: out.data,
      meta: out.meta,
    });
  } catch (err) {
    console.error("Get delivery logs error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to fetch single-user delivery logs.",
    });
  }
}

/* ======================================================
   Create notification to roles (in_app/email/sms)
====================================================== */
async function createSystemNotification(req, res) {
  try {
    const {
      user_id,
      user_name,
      title,
      message,
      delivery_channels,
      target_audience,
    } = req.body || {};

    const createdBy = user_id || null;
    const adminName = user_name || "System";

    // Validate title and message
    if (
      !title ||
      !String(title).trim() ||
      !message ||
      !String(message).trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Title and message are required.",
      });
    }

    // Validate delivery channels
    if (!Array.isArray(delivery_channels) || delivery_channels.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one delivery channel is required.",
      });
    }

    // Validate target audience
    if (!Array.isArray(target_audience) || target_audience.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one target audience is required.",
      });
    }

    // ✅ Validate roles are allowed
    const allowedRoles = [
      "user",
      "driver",
      "merchant",
      "admin",
      "superadmin",
      "finance",
      "organizer",
    ];
    const invalidRoles = target_audience.filter(
      (role) => !allowedRoles.includes(String(role).trim().toLowerCase()),
    );

    if (invalidRoles.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid target audience roles: ${invalidRoles.join(", ")}. Allowed roles are: ${allowedRoles.join(", ")}`,
      });
    }

    const norm = (s) =>
      String(s || "")
        .trim()
        .toLowerCase();
    const lowerChannels = delivery_channels.map(norm);
    const roles = target_audience
      .map((r) =>
        String(r || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);

    const wantsInApp = lowerChannels.includes("in_app");
    const wantsEmail = lowerChannels.includes("email");
    const wantsSms = lowerChannels.includes("sms");

    let notificationId = null;
    let emailSummary = null;
    let smsSummary = null;

    if (wantsInApp) {
      notificationId = await insertSystemNotification({
        title: String(title).trim(),
        message: String(message).trim(),
        deliveryChannels: ["in_app"],
        targetAudience: roles,
        createdBy,
      });

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: `Created IN_APP notification #${notificationId} - "${String(
          title,
        ).trim()}" for roles [${roles.join(", ")}]`,
      });
    }

    if (wantsEmail) {
      emailSummary = await sendNotificationEmails({
        notificationId,
        title: String(title).trim(),
        message: String(message).trim(),
        roles,
      });

      const sent = Number(emailSummary?.sent || 0);
      const failed = Number(emailSummary?.failed || 0);
      const skipped = Number(emailSummary?.skipped || 0);
      const total =
        emailSummary?.total != null
          ? Number(emailSummary.total)
          : sent + failed + skipped;

      let logMessage = `Sent EMAIL notification to roles [${roles.join(", ")}]`;
      if (notificationId) logMessage += ` (Notification #${notificationId})`;
      logMessage += ` — total: ${total}, sent: ${sent}, failed: ${failed}, skipped: ${skipped}`;

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: logMessage,
      });
    }

    if (wantsSms) {
      smsSummary = await sendNotificationSmsBulk({
        title: String(title).trim(),
        message: String(message).trim(),
        roles,
      });

      const total = Number(smsSummary?.total || 0);
      const sent = Number(smsSummary?.sent || 0);
      const failed = Number(smsSummary?.failed || 0);
      const batches = Number(smsSummary?.batches || 0);

      let logMessage = `Sent SMS notification to roles [${roles.join(", ")}]`;
      if (notificationId) logMessage += ` (Notification #${notificationId})`;
      logMessage += ` — total: ${total}, sent: ${sent}, failed: ${failed}, batches: ${batches}`;

      await adminLogModel.addLog({
        user_id: createdBy,
        admin_name: adminName,
        activity: logMessage,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Notification processed successfully.",
      notification_id: notificationId,
      email_summary: emailSummary,
      sms_summary: smsSummary,
    });
  } catch (err) {
    console.error("Create notification error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   Fetch all IN_APP notifications (admin)
====================================================== */
async function getAllSystemNotificationsController(req, res) {
  try {
    const notifications = await getAllSystemNotifications();
    return res.json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    console.error("Get all notifications error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

/* ======================================================
   Fetch notifications visible to user by role
====================================================== */
async function getSystemNotificationsByUser(req, res) {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required.",
      });
    }

    const notifications = await getNotificationsForUserRole(userId);

    return res.json({
      success: true,
      user_id: userId,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    console.error("Get user notifications error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: err?.message || String(err),
    });
  }
}

module.exports = {
  createSystemNotification,
  getAllSystemNotificationsController,
  getSystemNotificationsByUser,
  sendSmsToSingleUser,
  sendEmailToSingleUser,
  getSingleUserDeliveryLogsByUserIdController,
};
