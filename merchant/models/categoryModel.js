const { prisma } = require("../lib/prisma");
const moment = require("moment-timezone");

/* ========== helpers ========== */

// Format date to ISO string
function formatDate(date) {
  if (!date) return null;
  return moment(date).tz("Asia/Thimphu").toISOString();
}

function toStrOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function toIntOrThrow(v, name = "id") {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer`);
  return n;
}

const TABLE_BY_KIND = {
  food: "food_category",
  mart: "mart_category",
};

function tableForKind(kind) {
  const k = String(kind || "").toLowerCase();
  const t = TABLE_BY_KIND[k];
  if (!t) throw new Error("Invalid kind; must be 'food' or 'mart'");
  return t;
}

/** Verify admin identity: user exists and user_name matches admin_name */
async function verifyAdmin(user_id, admin_name) {
  if (!user_id || !admin_name) {
    throw new Error(
      "Admin verification failed: user_id and admin_name are required",
    );
  }
  const user = await prisma.users.findUnique({
    where: { user_id: toIntOrThrow(user_id, "user_id") },
    select: { user_id: true, user_name: true },
  });
  if (!user) {
    throw new Error("Admin verification failed: user not found");
  }
  const matches =
    user.user_name?.toLowerCase() === String(admin_name).toLowerCase();
  if (!matches) {
    throw new Error(
      "Admin verification failed: admin_name does not match user",
    );
  }
  return user;
}

/** Log admin action */
async function logAdminActionSafe(user_id, admin_name, activity) {
  try {
    await prisma.admin_logs.create({
      data: {
        user_id: user_id ? toIntOrThrow(user_id) : null,
        admin_name: toStrOrNull(admin_name),
        activity: toStrOrNull(activity),
        created_at: new Date(),
      },
    });
  } catch (e) {
    console.warn("admin_logs insert failed:", e.message);
  }
}

/** Resolve business type by NAME - filter in JavaScript */
async function resolveBusinessTypeByNameOrThrow(kind, business_type_name) {
  const name = String(business_type_name || "").trim();
  if (!name) throw new Error("business_type (name) is required");
  const k = String(kind).toLowerCase();

  const allBusinessTypes = await prisma.business_types.findMany();

  const matched = allBusinessTypes.find(
    (bt) =>
      bt.name?.toLowerCase() === name.toLowerCase() &&
      (!bt.types || bt.types.toLowerCase() === k),
  );

  if (!matched) {
    throw new Error(`Business type "${name}" not found for kind "${k}"`);
  }
  return matched;
}

/* ========== queries ========== */

// List all (ordered by name)
async function getAllCategories(kind) {
  try {
    const table = tableForKind(kind);
    let rows = [];

    if (table === "food_category") {
      rows = await prisma.food_category.findMany({
        orderBy: { category_name: "asc" },
      });
    } else {
      rows = await prisma.mart_category.findMany({
        orderBy: { category_name: "asc" },
      });
    }

    if (!rows.length) {
      return { success: false, message: "No categories found.", data: [] };
    }

    const formattedRows = rows.map((row) => ({
      id: Number(row.id),
      category_name: row.category_name,
      business_type: row.business_type,
      description: row.description,
      category_image: row.category_image,
      created_at: formatDate(row.created_at),
      updated_at: formatDate(row.updated_at),
    }));

    return { success: true, data: formattedRows };
  } catch (error) {
    console.error("getAllCategories error:", error);
    return { success: false, message: "Failed to fetch categories.", data: [] };
  }
}

// Get one by id
async function getCategoryById(kind, id) {
  try {
    const table = tableForKind(kind);
    let row = null;

    if (table === "food_category") {
      row = await prisma.food_category.findUnique({
        where: { id: Number(id) },
      });
    } else {
      row = await prisma.mart_category.findUnique({
        where: { id: Number(id) },
      });
    }

    if (!row) {
      return {
        success: false,
        message: `Category (kind=${kind}) id ${id} not found.`,
      };
    }

    return {
      success: true,
      data: {
        id: Number(row.id),
        category_name: row.category_name,
        business_type: row.business_type,
        description: row.description,
        category_image: row.category_image,
        created_at: formatDate(row.created_at),
        updated_at: formatDate(row.updated_at),
      },
    };
  } catch (error) {
    console.error("getCategoryById error:", error);
    return { success: false, message: "Failed to fetch category." };
  }
}

// Get by business_type (name) within kind - filter in JavaScript
async function getCategoriesByBusinessType(kind, business_type_name) {
  try {
    const table = tableForKind(kind);
    const name = String(business_type_name || "").trim();
    if (!name) {
      return {
        success: false,
        message: "business_type (name) is required",
        data: [],
      };
    }

    let allRows = [];
    if (table === "food_category") {
      allRows = await prisma.food_category.findMany({
        orderBy: { category_name: "asc" },
      });
    } else {
      allRows = await prisma.mart_category.findMany({
        orderBy: { category_name: "asc" },
      });
    }

    // Filter in JavaScript for case-insensitive match
    const filteredRows = allRows.filter(
      (row) => row.business_type?.toLowerCase() === name.toLowerCase(),
    );

    if (!filteredRows.length) {
      return {
        success: false,
        message: `No categories found for business_type "${name}" in ${table}.`,
        data: [],
      };
    }

    const formattedRows = filteredRows.map((row) => ({
      id: Number(row.id),
      category_name: row.category_name,
      business_type: row.business_type,
      description: row.description,
      category_image: row.category_image,
      created_at: formatDate(row.created_at),
      updated_at: formatDate(row.updated_at),
    }));

    return { success: true, data: formattedRows };
  } catch (error) {
    console.error("getCategoriesByBusinessType error:", error);
    return {
      success: false,
      message: "Failed to fetch categories by business type.",
    };
  }
}

/* ========== create ========== */
async function addCategory(
  kind,
  { category_name, business_type, description, category_image },
  user_id,
  admin_name,
) {
  try {
    const table = tableForKind(kind);
    await verifyAdmin(user_id, admin_name);
    const btRow = await resolveBusinessTypeByNameOrThrow(
      kind,
      business_type || kind,
    );

    const name = toStrOrNull(category_name);
    const desc = toStrOrNull(description);
    const img = toStrOrNull(category_image);

    if (!name) {
      return { success: false, message: "category_name is required." };
    }

    // Check for duplicate - fetch all and filter in JavaScript
    let existingRows = [];
    if (table === "food_category") {
      existingRows = await prisma.food_category.findMany();
    } else {
      existingRows = await prisma.mart_category.findMany();
    }

    const isDuplicate = existingRows.some(
      (row) =>
        row.business_type?.toLowerCase() === btRow.name.toLowerCase() &&
        row.category_name?.toLowerCase() === name.toLowerCase(),
    );

    if (isDuplicate) {
      return {
        success: false,
        message: `Category "${name}" already exists for business_type "${btRow.name}".`,
      };
    }

    let result;
    if (table === "food_category") {
      result = await prisma.food_category.create({
        data: {
          category_name: name,
          business_type: btRow.name,
          description: desc,
          category_image: img,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    } else {
      result = await prisma.mart_category.create({
        data: {
          category_name: name,
          business_type: btRow.name,
          description: desc,
          category_image: img,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }

    await logAdminActionSafe(
      user_id,
      admin_name,
      `CREATE ${table}: "${name}" (business_type="${btRow.name}", kind=${btRow.types || kind}, image=${img || "-"})`,
    );

    return {
      success: true,
      message: `Category "${name}" created successfully.`,
      data: {
        id: Number(result.id),
        category_name: result.category_name,
        business_type: result.business_type,
        description: result.description,
        category_image: result.category_image,
        created_at: formatDate(result.created_at),
        updated_at: formatDate(result.updated_at),
      },
    };
  } catch (error) {
    console.error("addCategory error:", error);
    return {
      success: false,
      message: error.message || "Failed to create category.",
    };
  }
}

/* ========== update ========== */
async function updateCategory(
  kind,
  id,
  { category_name, business_type, description, category_image },
  user_id,
  admin_name,
) {
  try {
    const table = tableForKind(kind);
    await verifyAdmin(user_id, admin_name);

    const existing = await getCategoryById(kind, id);
    if (!existing.success) {
      return { success: false, message: existing.message };
    }
    const prev = existing.data;

    let btNameToStore;
    if (business_type !== undefined) {
      const btRow = await resolveBusinessTypeByNameOrThrow(kind, business_type);
      btNameToStore = btRow.name;
    }

    const name =
      category_name !== undefined ? toStrOrNull(category_name) : undefined;
    const desc =
      description !== undefined ? toStrOrNull(description) : undefined;
    const img =
      category_image !== undefined ? toStrOrNull(category_image) : undefined;

    if (name === null) {
      return { success: false, message: "category_name cannot be empty." };
    }

    const finalName = name !== undefined ? name : prev.category_name;
    const finalBT =
      btNameToStore !== undefined ? btNameToStore : prev.business_type;

    // Check for duplicate - fetch all except current and filter in JavaScript
    let existingRows = [];
    if (table === "food_category") {
      existingRows = await prisma.food_category.findMany({
        where: { id: { not: Number(id) } },
      });
    } else {
      existingRows = await prisma.mart_category.findMany({
        where: { id: { not: Number(id) } },
      });
    }

    const isDuplicate = existingRows.some(
      (row) =>
        row.business_type?.toLowerCase() === finalBT.toLowerCase() &&
        row.category_name?.toLowerCase() === finalName.toLowerCase(),
    );

    if (isDuplicate) {
      return {
        success: false,
        message: `Another category "${finalName}" already exists for business_type "${finalBT}".`,
      };
    }

    const updateData = {};
    if (name !== undefined) updateData.category_name = name;
    if (btNameToStore !== undefined) updateData.business_type = btNameToStore;
    if (desc !== undefined) updateData.description = desc;
    if (img !== undefined) updateData.category_image = img;
    updateData.updated_at = new Date();

    if (Object.keys(updateData).length === 1) {
      return {
        success: true,
        message: "No changes.",
        data: prev,
        old_image: prev.category_image,
        new_image: prev.category_image,
      };
    }

    let updated;
    if (table === "food_category") {
      updated = await prisma.food_category.update({
        where: { id: Number(id) },
        data: updateData,
      });
    } else {
      updated = await prisma.mart_category.update({
        where: { id: Number(id) },
        data: updateData,
      });
    }

    await logAdminActionSafe(
      user_id,
      admin_name,
      `UPDATE ${table}: id=${id} "${finalName}" (business_type="${finalBT}", image=${img !== undefined ? img || "-" : "(unchanged)"})`,
    );

    return {
      success: true,
      message: "Category updated successfully.",
      data: {
        id: Number(updated.id),
        category_name: updated.category_name,
        business_type: updated.business_type,
        description: updated.description,
        category_image: updated.category_image,
        created_at: formatDate(updated.created_at),
        updated_at: formatDate(updated.updated_at),
      },
      old_image: prev.category_image,
      new_image: updated.category_image,
    };
  } catch (error) {
    console.error("updateCategory error:", error);
    return {
      success: false,
      message: error.message || "Failed to update category.",
    };
  }
}

/** Delete */
async function deleteCategory(kind, id, user_id, admin_name) {
  try {
    const table = tableForKind(kind);

    // First, get the category before deletion (without using getCategoryById to avoid extra connection)
    let category = null;
    if (table === "food_category") {
      category = await prisma.food_category.findUnique({
        where: { id: Number(id) },
      });
    } else {
      category = await prisma.mart_category.findUnique({
        where: { id: Number(id) },
      });
    }

    if (!category) {
      return {
        success: false,
        message: `Category (kind=${kind}) id ${id} not found.`,
      };
    }

    // Verify admin first (lightweight operation)
    if (user_id && admin_name) {
      const user = await prisma.users.findUnique({
        where: { user_id: toIntOrThrow(user_id, "user_id") },
        select: { user_id: true, user_name: true },
      });
      if (
        !user ||
        user.user_name?.toLowerCase() !== String(admin_name).toLowerCase()
      ) {
        return { success: false, message: "Admin verification failed." };
      }
    }

    // Delete the category
    if (table === "food_category") {
      await prisma.food_category.delete({
        where: { id: Number(id) },
      });
    } else {
      await prisma.mart_category.delete({
        where: { id: Number(id) },
      });
    }

    // Log action (don't wait for it - fire and forget)
    if (user_id && admin_name) {
      logAdminActionSafe(
        user_id,
        admin_name,
        `DELETE ${table}: id=${id} "${category.category_name}" (business_type="${category.business_type}")`,
      );
    }

    return {
      success: true,
      message: `Category "${category.category_name}" deleted successfully.`,
      old_image: category.category_image || null,
    };
  } catch (error) {
    console.error("deleteCategory error:", error);

    // Check for foreign key constraint
    if (error.code === "P2003") {
      return {
        success: false,
        message:
          "Cannot delete this category because it is being used by some menu items. Please remove all items from this category first.",
      };
    }

    if (error.code === "P2025") {
      return { success: false, message: `Category with ID ${id} not found.` };
    }

    return {
      success: false,
      message: error.message || "Failed to delete category. Please try again.",
    };
  }
}

/* ==================== categories by business_id flow ==================== */
async function getCategoriesForBusiness(business_id) {
  try {
    const bid = toIntOrThrow(business_id, "business_id");

    const business = await prisma.merchant_business_details.findUnique({
      where: { business_id: bid },
    });
    if (!business) throw new Error("Business not found");

    const merchantBusinessTypes = await prisma.merchant_business_types.findMany(
      {
        where: { business_id: bid },
        include: {
          business_types: {
            select: { id: true, name: true, types: true },
          },
        },
      },
    );

    if (!merchantBusinessTypes.length) {
      return { business_id: bid, types: [] };
    }

    const byKind = { food: [], mart: [] };
    for (const mbt of merchantBusinessTypes) {
      const kind =
        mbt.business_types?.types?.toLowerCase() === "mart" ? "mart" : "food";
      byKind[kind].push({
        id: mbt.business_types?.id,
        name: mbt.business_types?.name,
      });
    }

    const result = { business_id: bid, types: [] };

    // FOOD categories
    if (byKind.food.length) {
      const names = byKind.food.map((x) => x.name);
      const allFoodCategories = await prisma.food_category.findMany({
        orderBy: [{ business_type: "asc" }, { category_name: "asc" }],
      });

      // Filter in JavaScript
      const filteredFoodCategories = allFoodCategories.filter((cat) =>
        names.some(
          (name) => name.toLowerCase() === cat.business_type?.toLowerCase(),
        ),
      );

      const map = new Map();
      for (const { id, name } of byKind.food) {
        map.set(name.toLowerCase(), {
          kind: "food",
          business_type_id: id,
          business_type_name: name,
          categories: [],
        });
      }

      for (const cat of filteredFoodCategories) {
        const key = cat.business_type?.toLowerCase();
        const bucket = map.get(key);
        if (bucket) {
          bucket.categories.push({
            id: Number(cat.id),
            category_name: cat.category_name,
            business_type: cat.business_type,
            description: cat.description,
            category_image: cat.category_image,
            created_at: formatDate(cat.created_at),
            updated_at: formatDate(cat.updated_at),
          });
        }
      }
      result.types.push(...map.values());
    }

    // MART categories
    if (byKind.mart.length) {
      const names = byKind.mart.map((x) => x.name);
      const allMartCategories = await prisma.mart_category.findMany({
        orderBy: [{ business_type: "asc" }, { category_name: "asc" }],
      });

      // Filter in JavaScript
      const filteredMartCategories = allMartCategories.filter((cat) =>
        names.some(
          (name) => name.toLowerCase() === cat.business_type?.toLowerCase(),
        ),
      );

      const map = new Map();
      for (const { id, name } of byKind.mart) {
        map.set(name.toLowerCase(), {
          kind: "mart",
          business_type_id: id,
          business_type_name: name,
          categories: [],
        });
      }

      for (const cat of filteredMartCategories) {
        const key = cat.business_type?.toLowerCase();
        const bucket = map.get(key);
        if (bucket) {
          bucket.categories.push({
            id: Number(cat.id),
            category_name: cat.category_name,
            business_type: cat.business_type,
            description: cat.description,
            category_image: cat.category_image,
            created_at: formatDate(cat.created_at),
            updated_at: formatDate(cat.updated_at),
          });
        }
      }
      result.types.push(...map.values());
    }

    return result;
  } catch (error) {
    console.error("getCategoriesForBusiness error:", error);
    throw error;
  }
}

module.exports = {
  getAllCategories,
  getCategoryById,
  getCategoriesByBusinessType,
  addCategory,
  updateCategory,
  deleteCategory,
  getCategoriesForBusiness,
};
