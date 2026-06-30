const { prisma } = require("../lib/prisma.js");

/* =======================================================
   POINT EARNING RULES (existing)
   Table: point_system
======================================================= */

/**
 * Get all point rules
 * @param {boolean} onlyActive - if true, filter by is_active = true
 */
async function getAllPointRules(onlyActive = false) {
  const where = onlyActive ? { is_active: true } : {};

  const rows = await prisma.point_system.findMany({
    where,
    orderBy: { created_at: "desc" },
  });

  return rows.map((row) => ({
    point_id: Number(row.point_id),
    min_amount_per_point: Number(row.min_amount_per_point),
    point_to_award: Number(row.point_to_award),
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

/**
 * Get single point rule by id
 */
async function getPointRuleById(point_id) {
  const row = await prisma.point_system.findUnique({
    where: { point_id: Number(point_id) },
  });

  if (!row) return null;

  return {
    point_id: Number(row.point_id),
    min_amount_per_point: Number(row.min_amount_per_point),
    point_to_award: Number(row.point_to_award),
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Create new point earning rule
 */
async function createPointRule({
  min_amount_per_point,
  point_to_award,
  is_active = true,
}) {
  const result = await prisma.point_system.create({
    data: {
      min_amount_per_point: min_amount_per_point,
      point_to_award: point_to_award,
      is_active: is_active,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  return {
    point_id: Number(result.point_id),
    min_amount_per_point: Number(result.min_amount_per_point),
    point_to_award: Number(result.point_to_award),
    is_active: result.is_active,
    created_at: result.created_at,
    updated_at: result.updated_at,
  };
}

/**
 * Update existing point earning rule
 */
async function updatePointRule(
  point_id,
  { min_amount_per_point, point_to_award, is_active },
) {
  const data = {};

  if (min_amount_per_point !== undefined) {
    data.min_amount_per_point = min_amount_per_point;
  }

  if (point_to_award !== undefined) {
    data.point_to_award = point_to_award;
  }

  if (is_active !== undefined) {
    data.is_active = is_active;
  }

  if (Object.keys(data).length === 0) {
    return await getPointRuleById(point_id);
  }

  data.updated_at = new Date();

  try {
    const result = await prisma.point_system.update({
      where: { point_id: Number(point_id) },
      data,
    });

    return {
      point_id: Number(result.point_id),
      min_amount_per_point: Number(result.min_amount_per_point),
      point_to_award: Number(result.point_to_award),
      is_active: result.is_active,
      created_at: result.created_at,
      updated_at: result.updated_at,
    };
  } catch (error) {
    if (error.code === "P2025") {
      return null;
    }
    throw error;
  }
}

/**
 * Delete a point earning rule by id
 */
async function deletePointRule(point_id) {
  try {
    await prisma.point_system.delete({
      where: { point_id: Number(point_id) },
    });
    return true;
  } catch (error) {
    if (error.code === "P2025") {
      return false;
    }
    throw error;
  }
}

/* =======================================================
   POINT CONVERSION RULE (single-row)
   Table: point_conversion_rule
   Columns:
     id (always 1),
     points_required,
     wallet_amount,
     is_active,
     created_at,
     updated_at
======================================================= */

/**
 * Get the single point conversion rule (id = 1)
 */
async function getPointConversionRule() {
  const row = await prisma.point_conversion_rule.findUnique({
    where: { id: 1 },
  });

  if (!row) return null;

  return {
    id: Number(row.id),
    points_required: Number(row.points_required),
    wallet_amount: Number(row.wallet_amount),
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Create conversion rule only if it does NOT exist.
 * If rule exists (id=1), return null so controller can send message.
 */
async function createPointConversionRule({
  points_required,
  wallet_amount,
  is_active = true,
}) {
  // Check if a rule already exists
  const existing = await getPointConversionRule();
  if (existing) {
    return null; // signal "rule already exists"
  }

  const result = await prisma.point_conversion_rule.create({
    data: {
      id: 1,
      points_required: points_required,
      wallet_amount: wallet_amount,
      is_active: is_active,
      created_at: new Date(),
      updated_at: new Date(),
    },
  });

  return {
    id: Number(result.id),
    points_required: Number(result.points_required),
    wallet_amount: Number(result.wallet_amount),
    is_active: result.is_active,
    created_at: result.created_at,
    updated_at: result.updated_at,
  };
}

/**
 * Update existing conversion rule (partial)
 * If rule does not exist, returns null
 */
async function updatePointConversionRule({
  points_required,
  wallet_amount,
  is_active,
}) {
  const data = {};

  if (points_required !== undefined) {
    data.points_required = points_required;
  }

  if (wallet_amount !== undefined) {
    data.wallet_amount = wallet_amount;
  }

  if (is_active !== undefined) {
    data.is_active = is_active;
  }

  if (Object.keys(data).length === 0) {
    return await getPointConversionRule();
  }

  data.updated_at = new Date();

  try {
    const result = await prisma.point_conversion_rule.update({
      where: { id: 1 },
      data,
    });

    return {
      id: Number(result.id),
      points_required: Number(result.points_required),
      wallet_amount: Number(result.wallet_amount),
      is_active: result.is_active,
      created_at: result.created_at,
      updated_at: result.updated_at,
    };
  } catch (error) {
    if (error.code === "P2025") {
      return null;
    }
    throw error;
  }
}

/**
 * Delete the conversion rule (id = 1)
 */
async function deletePointConversionRule() {
  try {
    await prisma.point_conversion_rule.delete({
      where: { id: 1 },
    });
    return true;
  } catch (error) {
    if (error.code === "P2025") {
      return false;
    }
    throw error;
  }
}

module.exports = {
  // earning rules
  getAllPointRules,
  getPointRuleById,
  createPointRule,
  updatePointRule,
  deletePointRule,

  // conversion rule
  getPointConversionRule,
  createPointConversionRule,
  updatePointConversionRule,
  deletePointConversionRule,
};
