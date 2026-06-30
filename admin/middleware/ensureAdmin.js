// middleware/ensureAdmin.js
const { findPrivilegedByIdAndName } = require("../models/userModel");

module.exports = async function ensureAdmin(req, res, next) {
  try {
    const user_id =
      req.user?.user_id || req.user?.id || Number(req.headers["x-user-id"]);
    const admin_name =
      req.user?.user_name || req.user?.email || req.headers["x-admin-name"];

    if (!user_id || !admin_name) {
      return res.status(401).json({
        success: false,
        error:
          "Missing admin identity. Provide X-User-Id and X-Admin-Name headers or set req.user.user_name/email.",
      });
    }

    const actor = await findPrivilegedByIdAndName(user_id, admin_name);
    if (!actor) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: admin/superadmin required or name mismatch.",
      });
    }

    req.admin = {
      user_id: actor.user_id,
      admin_name: actor.user_name || actor.email || String(admin_name),
      role: actor.role,
      email: actor.email || null,
    };

    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
