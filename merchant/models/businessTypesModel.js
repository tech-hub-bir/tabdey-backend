const { prisma } = require("../lib/prisma");
const moment = require("moment-timezone");

/* ========== helpers ========== */

// Format date to ISO string
function formatDate(date) {
  if (!date) return null;
  return moment(date).tz("Asia/Thimphu").toISOString();
}

function toIntOrNull(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// allow array or CSV string; normalize to "a,b,c"
function normalizeTypes(input) {
  if (input == null) return null;
  if (Array.isArray(input)) {
    return input
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join(",");
  }
  return (
    String(input)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .join(",") || null
  );
}

/** Log admin action into admin_logs using Prisma relation */
async function logAdminAction(user_id, admin_name, activity) {
  try {
    let uid = toIntOrNull(user_id);

    await prisma.admin_logs.create({
      data: {
        admin_name: toStrOrNull(admin_name),
        activity: toStrOrNull(activity),
        created_at: new Date(),
        users: uid ? { connect: { user_id: uid } } : undefined,
      },
    });
  } catch (_e) {
    // swallow - don't let logging failures break the main operation
  }
}

/* ========== queries used by controller ========== */

/** List all business types */
async function getAllBusinessTypes() {
  try {
    const rows = await prisma.business_types.findMany({
      orderBy: { name: "asc" },
    });

    if (!rows.length) {
      return { success: false, message: "No business types found.", data: [] };
    }

    // Format dates and convert BigInt
    const formattedRows = rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      image: row.image,
      description: row.description,
      types: row.types,
      created_at: formatDate(row.created_at),
      updated_at: formatDate(row.updated_at),
    }));

    return { success: true, data: formattedRows };
  } catch (error) {
    console.error("getAllBusinessTypes error:", error);
    return {
      success: false,
      message: "Failed to fetch business types.",
      data: [],
    };
  }
}

/** Get one by ID */
async function getBusinessTypeById(id) {
  try {
    const row = await prisma.business_types.findUnique({
      where: { id: Number(id) },
    });

    if (!row) {
      return {
        success: false,
        message: `Business type with ID ${id} not found.`,
      };
    }

    return {
      success: true,
      data: {
        id: Number(row.id),
        name: row.name,
        image: row.image,
        description: row.description,
        types: row.types,
        created_at: formatDate(row.created_at),
        updated_at: formatDate(row.updated_at),
      },
    };
  } catch (error) {
    console.error("getBusinessTypeById error:", error);
    return { success: false, message: "Failed to fetch business type." };
  }
}

/** Get business types filtered by single token in 'types' (e.g., 'food' or 'mart') */
async function getBusinessTypesByType(typeToken) {
  try {
    const token = String(typeToken || "")
      .toLowerCase()
      .trim();
    if (!token) {
      return { success: false, message: "Type is required.", data: [] };
    }

    // Fetch all business types
    const allTypes = await prisma.business_types.findMany();

    // Filter case-insensitively in JavaScript
    const filteredTypes = allTypes.filter(
      (item) => item.types?.toLowerCase() === token,
    );

    if (!filteredTypes.length) {
      return {
        success: false,
        message: `No business types found for type "${token}".`,
        data: [],
      };
    }

    // Format dates and convert BigInt
    const formattedRows = filteredTypes.map((row) => ({
      id: Number(row.id),
      name: row.name,
      image: row.image,
      description: row.description,
      types: row.types,
      created_at: formatDate(row.created_at),
      updated_at: formatDate(row.updated_at),
    }));

    return { success: true, data: formattedRows };
  } catch (error) {
    console.error("getBusinessTypesByType error:", error);
    return {
      success: false,
      message: "Failed to fetch business types by type.",
    };
  }
}

/** Create */
async function addBusinessType(
  name,
  description,
  types,
  image,
  user_id,
  admin_name,
) {
  try {
    const n = toStrOrNull(name);
    const d = toStrOrNull(description);
    const t = toStrOrNull(normalizeTypes(types));
    const img = toStrOrNull(image);

    if (!n) {
      return { success: false, message: "Name is required." };
    }

    // Fetch all business types and check for duplicate in JavaScript
    const allTypes = await prisma.business_types.findMany({
      select: { name: true, types: true },
    });

    const isDuplicate = allTypes.some(
      (item) =>
        item.name?.toLowerCase() === n.toLowerCase() &&
        (item.types === t || (item.types === null && t === null)),
    );

    if (isDuplicate) {
      return {
        success: false,
        message: `Business type "${n}" with types "${t || "-"}" already exists.`,
      };
    }

    const result = await prisma.business_types.create({
      data: {
        name: n,
        image: img,
        description: d,
        types: t,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    await logAdminAction(
      user_id,
      admin_name,
      `CREATE business_types: "${n}" (types: ${t || "-"}, image: ${img || "-"})`,
    );

    return {
      success: true,
      message: `Business type "${n}" added successfully.`,
      insertedId: Number(result.id),
    };
  } catch (error) {
    console.error("addBusinessType error:", error);
    return {
      success: false,
      message: error.message || "Failed to add business type.",
    };
  }
}

/** Update */
async function updateBusinessType(
  id,
  name,
  description,
  types,
  image,
  user_id,
  admin_name,
) {
  try {
    const current = await getBusinessTypeById(id);
    if (!current.success) return current;

    const n = toStrOrNull(name);
    const d = toStrOrNull(description);
    const t = toStrOrNull(normalizeTypes(types));
    const img = toStrOrNull(image);

    if (!n) {
      return { success: false, message: "Name is required." };
    }

    // Fetch all business types except current and check for duplicate
    const allTypes = await prisma.business_types.findMany({
      where: { id: { not: Number(id) } },
      select: { name: true, types: true },
    });

    const isDuplicate = allTypes.some(
      (item) =>
        item.name?.toLowerCase() === n.toLowerCase() &&
        (item.types === t || (item.types === null && t === null)),
    );

    if (isDuplicate) {
      return {
        success: false,
        message: `Another business type "${n}" with types "${t || "-"}" already exists.`,
      };
    }

    await prisma.business_types.update({
      where: { id: Number(id) },
      data: {
        name: n,
        image: img,
        description: d,
        types: t,
        updated_at: new Date(),
      },
    });

    await logAdminAction(
      user_id,
      admin_name,
      `UPDATE business_types: id=${id} -> name="${n}", types="${t || "-"}", image=${img || "-"}`,
    );

    return {
      success: true,
      message: `Business type "${n}" updated successfully.`,
    };
  } catch (error) {
    console.error("updateBusinessType error:", error);
    return {
      success: false,
      message: error.message || "Failed to update business type.",
    };
  }
}

/** Delete */
async function deleteBusinessType(id, user_id, admin_name) {
  try {
    const bt = await getBusinessTypeById(id);
    if (!bt.success) return bt;

    await prisma.business_types.delete({
      where: { id: Number(id) },
    });

    await logAdminAction(
      user_id,
      admin_name,
      `DELETE business_types: id=${id} ("${bt.data.name}")`,
    );

    return {
      success: true,
      message: `Business type "${bt.data.name}" deleted successfully.`,
    };
  } catch (error) {
    console.error("deleteBusinessType error:", error);

    // Check for foreign key constraint (Prisma error code P2003)
    if (error.code === "P2003") {
      return {
        success: false,
        message: "Cannot delete: business type is in use by merchants.",
      };
    }

    return {
      success: false,
      message: error.message || "Failed to delete business type.",
    };
  }
}

module.exports = {
  getAllBusinessTypes,
  getBusinessTypeById,
  getBusinessTypesByType,
  addBusinessType,
  updateBusinessType,
  deleteBusinessType,
};
