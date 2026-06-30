const { prisma } = require("../lib/prisma.js");
const Collab = require("../models/adminCollaboratorModel");
const { addLog } = require("../models/adminlogModel");

// ─────────── AUTH HELPER USING BEARER TOKEN ───────────
async function requireAdmin(req) {
  // Get user_id from token (set by auth middleware)
  const admin_user_id = req.user?.user_id;

  if (!admin_user_id) {
    const e = new Error("Authentication required");
    e.status = 401;
    throw e;
  }

  // Find user with admin or superadmin role using Prisma
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

// ─────────── LOG FORMATTER ───────────
function formatLog(action, table, id, fields) {
  const parts = Object.entries(fields).map(
    ([k, v]) => `${k}="${v ?? "(null)"}"`,
  );
  return `${action} ${table}: id=${id} (${parts.join(", ")})`;
}

// ─────────── CREATE ───────────
exports.create = async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    const payload = req.body;

    if (
      await Collab.existsByEmailOrCid(payload.email, payload.cid ?? "", null)
    ) {
      return res
        .status(409)
        .json({ success: false, error: "Email or CID already exists" });
    }

    const data = await Collab.create(payload);

    await addLog({
      user_id: admin.user_id,
      admin_name: admin.admin_name,
      activity: formatLog(
        "CREATE",
        "admin_collaborators",
        data.collaborator_id,
        {
          full_name: data.full_name,
          contact: data.contact,
          email: data.email,
          service: data.service,
          role: data.role,
        },
      ),
    });

    res.status(201).json({ success: true, data });
  } catch (err) {
    console.error("Create collaborator error:", err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
};

// ─────────── LIST (PUBLIC - No auth required) ───────────
exports.list = async (_req, res) => {
  try {
    const data = await Collab.list();
    res.json({ success: true, data: data.data, total: data.total });
  } catch (err) {
    console.error("List collaborators error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────── GET ONE (PUBLIC - No auth required) ───────────
exports.getOne = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id)
      return res.status(400).json({ success: false, error: "Missing id" });

    const data = await Collab.findById(id);
    if (!data)
      return res.status(404).json({ success: false, error: "Not found" });

    res.json({ success: true, data });
  } catch (err) {
    console.error("Get collaborator error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────── UPDATE ───────────
exports.update = async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    const id = req.params.id;
    if (!id)
      return res.status(400).json({ success: false, error: "Missing id" });

    const before = await Collab.findById(id);
    if (!before)
      return res.status(404).json({ success: false, error: "Not found" });

    const { email, cid } = req.body || {};
    if ((email && email !== before.email) || (cid && cid !== before.cid)) {
      if (await Collab.existsByEmailOrCid(email || "", cid || "", id)) {
        return res
          .status(409)
          .json({ success: false, error: "Email or CID already exists" });
      }
    }

    const after = await Collab.updateById(id, req.body || {});

    const changes = {};
    for (const k of [
      "full_name",
      "contact",
      "email",
      "service",
      "role",
      "current_address",
      "cid",
    ]) {
      const oldVal = before[k];
      const newVal = after[k];
      if (oldVal !== newVal) {
        changes[k] = newVal ?? "(null)";
      }
    }

    if (Object.keys(changes).length > 0) {
      await addLog({
        user_id: admin.user_id,
        admin_name: admin.admin_name,
        activity: formatLog("UPDATE", "admin_collaborators", id, changes),
      });
    }

    res.json({ success: true, data: after });
  } catch (err) {
    console.error("Update collaborator error:", err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
};

// ─────────── DELETE ───────────
exports.remove = async (req, res) => {
  try {
    const admin = await requireAdmin(req);
    const id = req.params.id;
    if (!id)
      return res.status(400).json({ success: false, error: "Missing id" });

    const before = await Collab.findById(id);
    if (!before)
      return res.status(404).json({ success: false, error: "Not found" });

    const ok = await Collab.removeById(id);
    if (!ok)
      return res.status(404).json({ success: false, error: "Not found" });

    await addLog({
      user_id: admin.user_id,
      admin_name: admin.admin_name,
      activity: formatLog("DELETE", "admin_collaborators", id, {
        full_name: before.full_name,
        contact: before.contact,
        email: before.email,
        service: before.service,
        role: before.role,
      }),
    });

    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error("Delete collaborator error:", err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
};
