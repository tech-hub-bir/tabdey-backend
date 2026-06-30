const { prisma } = require("../lib/prisma.js");
const pointSystemModel = require("../models/pointSystemModel");
const { addLog } = require("../models/adminlogModel");

/**
 * Resolve admin identity (name + role label) from token and DB
 */
async function resolveAdminIdentity(req) {
  const u = req.user || {};
  const adminUserId = u.user_id || u.id || null;

  let tokenRole = u.role || null;
  let tokenName = u.admin_name || u.user_name || u.name || null;

  let dbName = null;
  let dbRole = null;

  // If we have user_id but no name, fetch from DB using Prisma
  if (adminUserId && !tokenName) {
    try {
      const user = await prisma.users.findUnique({
        where: { user_id: Number(adminUserId) },
        select: { user_name: true, role: true },
      });
      if (user) {
        dbName = user.user_name || null;
        dbRole = user.role || null;
      }
    } catch (err) {
      console.error("Failed to fetch admin info from users table:", err);
    }
  }

  const finalName = tokenName || dbName || null;
  const rawRole = tokenRole || dbRole || "";

  // Normalize role label for logging
  const normalized = String(rawRole).trim().toLowerCase();
  const compact = normalized.replace(/[\s_]+/g, "");

  let roleLabel = "Admin";
  if (compact === "superadmin") roleLabel = "Super admin";
  else if (normalized === "admin") roleLabel = "Admin";

  return {
    adminUserId,
    adminName: finalName,
    roleLabel,
  };
}

/**
 * Log admin action into admin_logs with clear message
 */
async function logAdminAction(req, actionDescription) {
  try {
    const { adminUserId, adminName, roleLabel } =
      await resolveAdminIdentity(req);

    let base;
    if (adminName && adminUserId) {
      base = `${roleLabel} "${adminName}" (id: ${adminUserId}) `;
    } else if (adminName) {
      base = `${roleLabel} "${adminName}" `;
    } else if (adminUserId) {
      base = `${roleLabel} (id: ${adminUserId}) `;
    } else {
      base = `${roleLabel} `;
    }

    const activity = `${base}${actionDescription}`;

    await addLog({
      user_id: adminUserId || null,
      admin_name: adminName || null,
      activity: activity,
    });
  } catch (err) {
    // Do not block main flow if logging fails
    console.error("Failed to write admin log (point_system):", err);
  }
}

/* =======================================================
   POINT EARNING RULES (existing)
======================================================= */

// GET /point-system?onlyActive=true
exports.getAllPointRules = async (req, res) => {
  try {
    const onlyActive =
      String(req.query.onlyActive || "").toLowerCase() === "true";
    const rules = await pointSystemModel.getAllPointRules(onlyActive);

    return res.status(200).json({
      success: true,
      count: rules.length,
      data: rules,
    });
  } catch (err) {
    console.error("Error fetching point rules:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// GET /point-system/:id
exports.getPointRuleById = async (req, res) => {
  try {
    const { id } = req.params;

    const rule = await pointSystemModel.getPointRuleById(id);
    if (!rule) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    return res.status(200).json({
      success: true,
      data: rule,
    });
  } catch (err) {
    console.error("Error fetching point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// POST /point-system
exports.createPointRule = async (req, res) => {
  try {
    const { min_amount_per_point, point_to_award, is_active } = req.body || {};

    if (min_amount_per_point === undefined || point_to_award === undefined) {
      return res.status(400).json({
        success: false,
        error: "min_amount_per_point and point_to_award are required.",
      });
    }

    const minAmountNum = Number(min_amount_per_point);
    const pointsNum = Number(point_to_award);

    if (!Number.isFinite(minAmountNum) || minAmountNum <= 0) {
      return res.status(400).json({
        success: false,
        error: "min_amount_per_point must be a positive number.",
      });
    }

    if (!Number.isInteger(pointsNum) || pointsNum < 0) {
      return res.status(400).json({
        success: false,
        error: "point_to_award must be a non-negative integer.",
      });
    }

    const rule = await pointSystemModel.createPointRule({
      min_amount_per_point: minAmountNum,
      point_to_award: pointsNum,
      is_active: is_active !== undefined ? !!is_active : true,
    });

    await logAdminAction(
      req,
      `created point earning rule (id: ${rule.point_id}, min_amount_per_point: ${rule.min_amount_per_point}, point_to_award: ${rule.point_to_award}, is_active: ${rule.is_active})`,
    );

    return res.status(201).json({
      success: true,
      message: "Point rule created successfully.",
      data: rule,
    });
  } catch (err) {
    console.error("Error creating point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// PUT /point-system/:id
exports.updatePointRule = async (req, res) => {
  try {
    const { id } = req.params;
    let { min_amount_per_point, point_to_award, is_active } = req.body || {};

    const updates = {};

    if (min_amount_per_point !== undefined) {
      const minAmountNum = Number(min_amount_per_point);
      if (!Number.isFinite(minAmountNum) || minAmountNum <= 0) {
        return res.status(400).json({
          success: false,
          error: "min_amount_per_point must be a positive number.",
        });
      }
      updates.min_amount_per_point = minAmountNum;
    }

    if (point_to_award !== undefined) {
      const pointsNum = Number(point_to_award);
      if (!Number.isInteger(pointsNum) || pointsNum < 0) {
        return res.status(400).json({
          success: false,
          error: "point_to_award must be a non-negative integer.",
        });
      }
      updates.point_to_award = pointsNum;
    }

    if (is_active !== undefined) {
      updates.is_active = !!is_active;
    }

    const updated = await pointSystemModel.updatePointRule(id, updates);

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    await logAdminAction(
      req,
      `updated point earning rule (id: ${updated.point_id}, min_amount_per_point: ${updated.min_amount_per_point}, point_to_award: ${updated.point_to_award}, is_active: ${updated.is_active})`,
    );

    return res.status(200).json({
      success: true,
      message: "Point rule updated successfully.",
      data: updated,
    });
  } catch (err) {
    console.error("Error updating point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// DELETE /point-system/:id
exports.deletePointRule = async (req, res) => {
  try {
    const { id } = req.params;

    const deleted = await pointSystemModel.deletePointRule(id);
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Point rule not found." });
    }

    await logAdminAction(req, `deleted point earning rule (id: ${id})`);

    return res.status(200).json({
      success: true,
      message: "Point rule deleted successfully.",
    });
  } catch (err) {
    console.error("Error deleting point rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

/* =======================================================
   POINT CONVERSION RULE (single-row)
======================================================= */

// GET /point-conversion-rule
exports.getPointConversionRule = async (req, res) => {
  try {
    const rule = await pointSystemModel.getPointConversionRule();
    if (!rule) {
      return res.status(404).json({
        success: false,
        message: "Point conversion rule not found.",
      });
    }

    return res.status(200).json({
      success: true,
      data: rule,
    });
  } catch (err) {
    console.error("Error fetching point conversion rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// POST /point-conversion-rule
exports.createPointConversionRule = async (req, res) => {
  try {
    const { points_required, wallet_amount, is_active } = req.body || {};

    if (points_required === undefined || wallet_amount === undefined) {
      return res.status(400).json({
        success: false,
        error: "points_required and wallet_amount are required.",
      });
    }

    // Check if rule already exists
    const existing = await pointSystemModel.getPointConversionRule();
    if (existing) {
      await logAdminAction(
        req,
        `attempted to create point conversion rule but one already exists (points_required: ${existing.points_required}, wallet_amount: ${existing.wallet_amount}, is_active: ${existing.is_active})`,
      );

      return res.status(400).json({
        success: false,
        error:
          "Point conversion rule already exists. Please edit the existing rule or delete it before creating a new one.",
      });
    }

    const points = Number(points_required);
    const amount = Number(wallet_amount);

    if (!Number.isInteger(points) || points <= 0) {
      return res.status(400).json({
        success: false,
        error: "points_required must be a positive integer.",
      });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "wallet_amount must be a positive number.",
      });
    }

    const rule = await pointSystemModel.createPointConversionRule({
      points_required: points,
      wallet_amount: amount,
      is_active: is_active !== undefined ? !!is_active : true,
    });

    if (!rule) {
      return res.status(400).json({
        success: false,
        error: "Failed to create point conversion rule.",
      });
    }

    await logAdminAction(
      req,
      `created point conversion rule (points_required: ${rule.points_required}, wallet_amount: ${rule.wallet_amount}, is_active: ${rule.is_active})`,
    );

    return res.status(201).json({
      success: true,
      message: "Point conversion rule created successfully.",
      data: rule,
    });
  } catch (err) {
    console.error("Error creating point conversion rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// PUT /point-conversion-rule
exports.updatePointConversionRule = async (req, res) => {
  try {
    const { points_required, wallet_amount, is_active } = req.body || {};
    const updates = {};

    if (points_required !== undefined) {
      const points = Number(points_required);
      if (!Number.isInteger(points) || points <= 0) {
        return res.status(400).json({
          success: false,
          error: "points_required must be a positive integer.",
        });
      }
      updates.points_required = points;
    }

    if (wallet_amount !== undefined) {
      const amount = Number(wallet_amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: "wallet_amount must be a positive number.",
        });
      }
      updates.wallet_amount = amount;
    }

    if (is_active !== undefined) {
      updates.is_active = !!is_active;
    }

    const updated = await pointSystemModel.updatePointConversionRule(updates);

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Point conversion rule not found.",
      });
    }

    await logAdminAction(
      req,
      `updated point conversion rule (points_required: ${updated.points_required}, wallet_amount: ${updated.wallet_amount}, is_active: ${updated.is_active})`,
    );

    return res.status(200).json({
      success: true,
      message: "Point conversion rule updated successfully.",
      data: updated,
    });
  } catch (err) {
    console.error("Error updating point conversion rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};

// DELETE /point-conversion-rule
exports.deletePointConversionRule = async (req, res) => {
  try {
    const deleted = await pointSystemModel.deletePointConversionRule();

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Point conversion rule not found.",
      });
    }

    await logAdminAction(req, "deleted point conversion rule (id: 1)");

    return res.status(200).json({
      success: true,
      message: "Point conversion rule deleted successfully.",
    });
  } catch (err) {
    console.error("Error deleting point conversion rule:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error.",
    });
  }
};
