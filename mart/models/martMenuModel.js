const { prisma } = require("../lib/prisma");

/* -------- helpers -------- */
const toStrOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

const toNumOrNull = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toBool = (v, def = false) => {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return Boolean(v);
};

const toBizId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("Business ID must be a positive integer.");
  return n;
};

/* -------- validations & resolvers -------- */

async function assertBusinessExists(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    select: { business_id: true },
  });
  if (!business) {
    throw new Error(
      `Business with ID ${business_id} does not exist. Please check the business ID.`,
    );
  }
}

async function getMerchantMartTypeNames(business_id) {
  try {
    const rows = await prisma.merchant_business_types.findMany({
      where: {
        business_id: business_id,
      },
      include: {
        business_types: {
          select: { name: true, types: true },
        },
      },
    });

    // Filter for mart-related business types (case-insensitive)
    const martTypes = rows.filter(
      (row) => row.business_types?.types?.toLowerCase() === "mart",
    );

    return martTypes.map((r) => r.business_types?.name).filter(Boolean);
  } catch (error) {
    console.error("Error getting merchant mart types:", error);
    return []; // Return empty array instead of throwing
  }
}

async function getMartCategoryByName(category_name) {
  const category = await prisma.mart_category.findFirst({
    where: {
      category_name: category_name.toLowerCase(), // Convert to lowercase
    },
  });
  return category;
}

async function assertCategoryAllowedForBusiness(business_id, category_name) {
  const category = await getMartCategoryByName(category_name);
  if (!category) {
    throw new Error(
      `Category ${category_name} does not exist in mart category list. Please select a valid category.`,
    );
  }

  const merchantMartTypes = await getMerchantMartTypeNames(business_id);
  if (!merchantMartTypes.length) {
    throw new Error(
      `This business is not registered for any MART services. Please contact support.`,
    );
  }

  const allowed = merchantMartTypes
    .map((n) => n.toLowerCase())
    .includes(String(category.business_type).toLowerCase());

  if (!allowed) {
    throw new Error(
      `Category "${category_name}" belongs to "${category.business_type}" category type, ` +
        `but your business is not registered for this service.`,
    );
  }
  return category;
}

async function assertUniquePerBusinessCategory(
  business_id,
  category_name,
  item_name,
  excludeId = null,
) {
  const whereCondition = {
    business_id: business_id,
    category_name: category_name.toLowerCase(), // Convert to lowercase
    item_name: {
      equals: item_name.toLowerCase(), // Convert to lowercase instead of using mode
    },
  };

  if (excludeId) {
    whereCondition.id = { not: excludeId };
  }

  const existing = await prisma.mart_menu.findFirst({
    where: whereCondition,
    select: { id: true },
  });

  if (existing) {
    throw new Error(
      `Item "${item_name}" already exists in category "${category_name}". Please use a different item name.`,
    );
  }
}

function validateSpiceLevel(spice_level) {
  const validLevels = ["None", "Mild", "Medium", "Hot"];
  if (spice_level && !validLevels.includes(spice_level)) {
    throw new Error(`Spice level must be one of: ${validLevels.join(", ")}.`);
  }
  return spice_level || "None";
}

function validatePrice(price, fieldName) {
  const num = toNumOrNull(price);
  if (num === null || num < 0) {
    throw new Error(`${fieldName} must be a valid non-negative number.`);
  }
  return num;
}

function validateDiscount(discount) {
  const num = toNumOrNull(discount);
  if (num === null) return 0;
  if (num < 0 || num > 100) {
    throw new Error(`Discount percentage must be between 0 and 100.`);
  }
  return num;
}

/* -------- MART PRODUCT INFO CRUD -------- */

async function upsertMartProductInfo(data) {
  try {
    const { menu_id, size_standard, available_sizes, product_images } = data;

    const result = await prisma.mart_product_info.upsert({
      where: { menu_id: menu_id },
      update: {
        size_standard: size_standard || null,
        available_sizes: available_sizes || null,
        product_images: product_images || null,
        updated_at: new Date(),
      },
      create: {
        menu_id: menu_id,
        size_standard: size_standard || null,
        available_sizes: available_sizes || null,
        product_images: product_images || null,
      },
    });

    return { success: true, data: result };
  } catch (error) {
    console.error("Upsert product info error:", error);
    return { success: false, message: error.message };
  }
}

async function getMartProductInfoByMenuId(menu_id) {
  try {
    const result = await prisma.mart_product_info.findUnique({
      where: { menu_id: menu_id },
    });
    return result;
  } catch (error) {
    console.error("Get product info error:", error);
    return null;
  }
}

async function deleteMartProductInfoByMenuId(menu_id) {
  try {
    await prisma.mart_product_info.delete({
      where: { menu_id: menu_id },
    });
    return { success: true };
  } catch (error) {
    console.error("Delete product info error:", error);
    return { success: false, message: error.message };
  }
}

/* -------- Main CRUD Operations -------- */

async function createMartMenuItem(payload) {
  try {
    const {
      business_id,
      category_name,
      item_name,
      description,
      item_image,
      actual_price,
      discount_percentage,
      tax_rate,
      is_veg,
      spice_level,
      is_available,
      stock_limit,
      sort_order,
    } = payload;

    // Validate required fields
    if (!business_id) {
      throw new Error("Business ID is required.");
    }
    if (!category_name) {
      throw new Error("Category name is required.");
    }
    if (!item_name) {
      throw new Error("Item name is required.");
    }

    const bizId = toBizId(business_id);
    const catName = toStrOrNull(category_name);
    const itemName = toStrOrNull(item_name);
    const price = validatePrice(actual_price, "Price");
    const discount = validateDiscount(discount_percentage);
    const tax = validatePrice(tax_rate, "Tax rate") ?? 0;
    const isVeg = toBool(is_veg, false);
    const spice = validateSpiceLevel(spice_level);
    const isAvail = toBool(is_available, true);
    const stock = toNumOrNull(stock_limit) ?? 0;
    const sort = toNumOrNull(sort_order) ?? 0;
    const desc = toStrOrNull(description);
    const img = toStrOrNull(item_image);
    const catNameLower = catName.toLowerCase();

    await assertBusinessExists(bizId);
    await assertCategoryAllowedForBusiness(bizId, catNameLower);
    await assertUniquePerBusinessCategory(bizId, catNameLower, itemName);

    const result = await prisma.mart_menu.create({
      data: {
        business_id: bizId,
        category_name: catNameLower,
        item_name: itemName,
        description: desc,
        item_image: img,
        actual_price: price,
        discount_percentage: discount,
        tax_rate: tax,
        is_veg: isVeg,
        spice_level: spice,
        is_available: isAvail,
        stock_limit: stock,
        sort_order: sort,
      },
    });

    const createdItem = await getMartMenuItemById(result.id);
    return {
      success: true,
      message: "Mart item created successfully.",
      data: createdItem.data,
    };
  } catch (error) {
    console.error("Create mart item error:", error);
    return {
      success: false,
      message: error.message || "Failed to create mart item. Please try again.",
    };
  }
}

async function getMartMenuItemById(id) {
  try {
    const item = await prisma.mart_menu.findUnique({
      where: { id: id },
      include: {
        mart_product_info: true, // Always include if exists
      },
    });

    if (!item) {
      return {
        success: false,
        message: `Mart item with ID ${id} was not found.`,
      };
    }

    // Format the response
    const formattedItem = {
      ...item,
      is_veg: item.is_veg ? 1 : 0,
      is_available: item.is_available ? 1 : 0,
      // If product info exists, include it, otherwise null
      product_info: item.mart_product_info || null,
    };

    // Remove the raw relation from response
    delete formattedItem.mart_product_info;

    return {
      success: true,
      data: formattedItem,
    };
  } catch (error) {
    console.error("Get mart item error:", error);
    return {
      success: false,
      message: "Failed to fetch mart item. Please try again.",
    };
  }
}
async function listMartMenuItems({ business_id, category_name } = {}) {
  try {
    const whereCondition = {};

    if (business_id) {
      whereCondition.business_id = toBizId(business_id);
    }

    if (category_name) {
      whereCondition.category_name = category_name.toLowerCase();
    }

    const rows = await prisma.mart_menu.findMany({
      where: whereCondition,
      include: {
        mart_product_info: true, // Include product info for all items
      },
      orderBy: [{ sort_order: "asc" }, { item_name: "asc" }],
    });

    const formattedRows = rows.map((item) => ({
      ...item,
      is_veg: item.is_veg ? 1 : 0,
      is_available: item.is_available ? 1 : 0,
      // Include product info if exists, otherwise null
      product_info: item.mart_product_info || null,
    }));

    // Remove the raw relation from each item
    formattedRows.forEach((row) => delete row.mart_product_info);

    return {
      success: true,
      data: formattedRows,
      count: formattedRows.length,
    };
  } catch (error) {
    console.error("List mart items error:", error);
    return {
      success: false,
      message: "Failed to fetch mart items. Please try again.",
    };
  }
}

async function listMartMenuByBusiness(business_id) {
  try {
    const bizId = toBizId(business_id);
    await assertBusinessExists(bizId);

    const rows = await prisma.mart_menu.findMany({
      where: { business_id: bizId },
      include: {
        mart_product_info: true, // MAKE SURE THIS LINE EXISTS
      },
      orderBy: [
        { category_name: "asc" },
        { sort_order: "asc" },
        { item_name: "asc" },
      ],
    });

    const formattedRows = rows.map((item) => ({
      ...item,
      is_veg: item.is_veg ? 1 : 0,
      is_available: item.is_available ? 1 : 0,
      product_info: item.mart_product_info || null, // ADD THIS LINE
    }));

    // Remove the raw relation
    formattedRows.forEach((row) => delete row.mart_product_info);

    return {
      success: true,
      data: formattedRows,
      count: formattedRows.length,
    };
  } catch (error) {
    console.error("List business mart items error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch mart items for this business.",
    };
  }
}

async function updateMartMenuItem(id, fields) {
  try {
    const existing = await getMartMenuItemById(id);
    if (!existing.success) {
      return existing;
    }

    const prev = existing.data;
    const updates = {};

    if ("business_id" in fields) {
      const bizId = toBizId(fields.business_id);
      await assertBusinessExists(bizId);
      updates.business_id = bizId;
    }

    if ("category_name" in fields) {
      const cat = toStrOrNull(fields.category_name);
      if (!cat) throw new Error("Category name cannot be empty.");
      const finalBiz = updates.business_id ?? prev.business_id;
      await assertCategoryAllowedForBusiness(finalBiz, cat.toLowerCase());
      updates.category_name = cat.toLowerCase();
    }

    if ("item_name" in fields) {
      const name = toStrOrNull(fields.item_name);
      if (!name) throw new Error("Item name cannot be empty.");
      updates.item_name = name;
    }

    if ("description" in fields) {
      updates.description = toStrOrNull(fields.description);
    }

    if ("item_image" in fields) {
      updates.item_image = toStrOrNull(fields.item_image);
    }

    if ("actual_price" in fields) {
      updates.actual_price = validatePrice(fields.actual_price, "Price");
    }

    if ("discount_percentage" in fields) {
      updates.discount_percentage = validateDiscount(
        fields.discount_percentage,
      );
    }

    if ("tax_rate" in fields) {
      updates.tax_rate = validatePrice(fields.tax_rate, "Tax rate") ?? 0;
    }

    if ("is_veg" in fields) {
      updates.is_veg = toBool(fields.is_veg, false);
    }

    if ("spice_level" in fields) {
      updates.spice_level = validateSpiceLevel(fields.spice_level);
    }

    if ("is_available" in fields) {
      updates.is_available = toBool(fields.is_available, true);
    }

    if ("stock_limit" in fields) {
      updates.stock_limit = toNumOrNull(fields.stock_limit) ?? 0;
    }

    if ("sort_order" in fields) {
      updates.sort_order = toNumOrNull(fields.sort_order) ?? 0;
    }

    const finalBiz = updates.business_id ?? prev.business_id;
    const finalCat = updates.category_name ?? prev.category_name;
    const finalName = updates.item_name ?? prev.item_name;

    if (finalName !== prev.item_name || finalCat !== prev.category_name) {
      await assertUniquePerBusinessCategory(finalBiz, finalCat, finalName, id);
    }

    if (Object.keys(updates).length === 0) {
      return {
        success: true,
        message: "No changes were made to the mart item.",
        data: prev,
      };
    }

    await prisma.mart_menu.update({
      where: { id: id },
      data: {
        ...updates,
        updated_at: new Date(),
      },
    });

    const updatedItem = await getMartMenuItemById(id);

    return {
      success: true,
      message: "Mart item updated successfully.",
      data: updatedItem.data,
      old_image: prev.item_image,
      new_image: updatedItem.data.item_image,
    };
  } catch (error) {
    console.error("Update mart item error:", error);
    return {
      success: false,
      message: error.message || "Failed to update mart item. Please try again.",
    };
  }
}

async function deleteMartMenuItem(id) {
  try {
    const existing = await getMartMenuItemById(id);
    if (!existing.success) {
      return existing;
    }

    await prisma.mart_menu.delete({
      where: { id: id },
    });

    return {
      success: true,
      message: "Mart item deleted successfully.",
      old_image: existing.data.item_image,
    };
  } catch (error) {
    console.error("Delete mart item error:", error);
    return {
      success: false,
      message: error.message || "Failed to delete mart item. Please try again.",
    };
  }
}

module.exports = {
  createMartMenuItem,
  getMartMenuItemById,
  listMartMenuItems,
  listMartMenuByBusiness,
  updateMartMenuItem,
  deleteMartMenuItem,
  upsertMartProductInfo,
  getMartProductInfoByMenuId,
  deleteMartProductInfoByMenuId,
};
