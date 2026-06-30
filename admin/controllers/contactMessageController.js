const { prisma } = require("../lib/prisma.js");
const ContactModel = require("../models/contactMessageModel");
const { addLog } = require("../models/adminlogModel");

/* =======================================================
   AUTH HELPER FOR ADMIN
======================================================= */
async function requireAdmin(req) {
  const admin_user_id = req.user?.user_id;

  if (!admin_user_id) {
    const e = new Error("Authentication required");
    e.status = 401;
    throw e;
  }

  const actor = await prisma.users.findFirst({
    where: {
      user_id: Number(admin_user_id),
      role: {
        in: ["admin", "superadmin", "super admin"],
      },
    },
    select: {
      user_id: true,
      user_name: true,
      email: true,
      role: true,
    },
  });

  if (!actor) {
    const e = new Error("Forbidden: Admin or Super Admin required");
    e.status = 403;
    throw e;
  }

  return {
    user_id: Number(actor.user_id),
    admin_name: actor.user_name || actor.email || "ADMIN",
    role: actor.role,
  };
}

/* =======================================================
   CREATE MESSAGE (PUBLIC - No auth required)
======================================================= */
async function createMessage(req, res) {
  try {
    const { full_name, contact_type, contact_value, user_type, message } =
      req.body;

    if (!full_name || !contact_type || !contact_value || !message) {
      return res.status(400).json({
        ok: false,
        message: "Required fields are missing",
      });
    }

    if (!["email", "phone"].includes(contact_type)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid contact type",
      });
    }

    const result = await ContactModel.createMessage({
      full_name,
      contact_type,
      contact_value,
      user_type,
      message,
    });

    return res.status(201).json({
      ok: true,
      message: "Message submitted successfully",
      data: { id: result.id },
    });
  } catch (err) {
    console.error("Create Message Error:", err);
    return res.status(500).json({
      ok: false,
      message: "Internal server error",
    });
  }
}

/* =======================================================
   GET ALL MESSAGES (ADMIN ONLY)
======================================================= */
async function getAllMessages(req, res) {
  try {
    // Verify admin access
    await requireAdmin(req);

    const { status, user_type } = req.query;

    const messages = await ContactModel.getAllMessages({
      status,
      user_type,
    });

    return res.json({
      ok: true,
      count: messages.length,
      data: messages,
    });
  } catch (err) {
    console.error("Get Messages Error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Internal server error",
    });
  }
}

/* =======================================================
   GET MESSAGE BY ID (ADMIN ONLY)
======================================================= */
async function getMessageById(req, res) {
  try {
    // Verify admin access
    await requireAdmin(req);

    const { id } = req.params;

    const message = await ContactModel.getMessageById(id);

    if (!message) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    return res.json({
      ok: true,
      data: message,
    });
  } catch (err) {
    console.error("Get Message Error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Internal server error",
    });
  }
}

/* =======================================================
   UPDATE STATUS (ADMIN ONLY)
======================================================= */
async function updateStatus(req, res) {
  try {
    // Verify admin access
    const admin = await requireAdmin(req);

    const { id } = req.params;
    const { status } = req.body;

    if (!["new", "read", "replied"].includes(status)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid status",
      });
    }

    const message = await ContactModel.getMessageById(id);
    if (!message) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    const updated = await ContactModel.updateMessageStatus(id, status);

    if (!updated) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    // Log the action
    try {
      await addLog({
        user_id: admin.user_id,
        admin_name: admin.admin_name,
        activity: `Admin ${admin.admin_name} (id=${admin.user_id}, role=${admin.role}) updated contact message #${id} status from "${message.status}" to "${status}"`,
      });
    } catch (e) {
      console.error("admin log failed:", e?.message || e);
    }

    return res.json({
      ok: true,
      message: "Status updated successfully",
    });
  } catch (err) {
    console.error("Update Status Error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Internal server error",
    });
  }
}

/* =======================================================
   DELETE MESSAGE (ADMIN ONLY)
======================================================= */
async function deleteMessage(req, res) {
  try {
    // Verify admin access
    const admin = await requireAdmin(req);

    const { id } = req.params;

    const message = await ContactModel.getMessageById(id);
    if (!message) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    const deleted = await ContactModel.deleteMessage(id);

    if (!deleted) {
      return res.status(404).json({
        ok: false,
        message: "Message not found",
      });
    }

    // Log the action
    try {
      await addLog({
        user_id: admin.user_id,
        admin_name: admin.admin_name,
        activity: `Admin ${admin.admin_name} (id=${admin.user_id}, role=${admin.role}) deleted contact message #${id} from ${message.full_name} (${message.contact_type}: ${message.contact_value})`,
      });
    } catch (e) {
      console.error("admin log failed:", e?.message || e);
    }

    return res.json({
      ok: true,
      message: "Message deleted successfully",
    });
  } catch (err) {
    console.error("Delete Message Error:", err);
    return res.status(err.status || 500).json({
      ok: false,
      message: err.message || "Internal server error",
    });
  }
}

module.exports = {
  createMessage,
  getAllMessages,
  getMessageById,
  updateStatus,
  deleteMessage,
};
