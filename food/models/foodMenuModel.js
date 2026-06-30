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

const toNumber = (v, fieldName) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return n;
};

/* -------- validations -------- */

async function validateBusinessExists(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    select: { business_id: true, business_name: true },
  });
  if (!business) {
    throw new Error(
      `Business with ID ${business_id} does not exist. Please check the business ID and try again.`,
    );
  }
  return business;
}

async function getMerchantFoodTypeNames(business_id) {
  const rows = await prisma.merchant_business_types.findMany({
    where: { business_id: business_id },
    include: {
      business_types: {
        select: { name: true, types: true },
      },
    },
  });

  return rows
    .filter((r) => r.business_types?.types?.toLowerCase() === "food")
    .map((r) => r.business_types?.name)
    .filter(Boolean);
}

async function validateCategoryExists(category_name) {
  const category = await prisma.food_category.findFirst({
    where: {
      category_name: category_name.toLowerCase(),
    },
  });
  if (!category) {
    throw new Error(
      `Category "${category_name}" does not exist. Available categories can be viewed in the categories list.`,
    );
  }
  return category;
}

async function validateCategoryAllowedForBusiness(business_id, category_name) {
  const category = await validateCategoryExists(category_name);
  const merchantFoodTypes = await getMerchantFoodTypeNames(business_id);

  if (!merchantFoodTypes.length) {
    throw new Error(
      `This business is not registered for any food services. Please contact support to enable food services.`,
    );
  }

  const isAllowed = merchantFoodTypes
    .map((t) => t.toLowerCase())
    .includes(String(category.business_type).toLowerCase());

  if (!isAllowed) {
    throw new Error(
      `Category "${category_name}" belongs to "${category.business_type}" category type, but your business is not registered for this service.`,
    );
  }

  return category;
}

// FIXED: This function now properly checks for duplicates BEFORE insert
async function checkDuplicateItem(
  business_id,
  category_name,
  item_name,
  excludeId = null,
) {
  // Build query for case-insensitive check
  let query = `
    SELECT id FROM food_menu 
    WHERE business_id = ? 
    AND LOWER(category_name) = LOWER(?) 
    AND LOWER(item_name) = LOWER(?)
  `;
  const params = [business_id, category_name, item_name];

  if (excludeId) {
    query += ` AND id != ?`;
    params.push(excludeId);
  }

  query += ` LIMIT 1`;

  const [rows] = await prisma.$queryRawUnsafe(query, ...params);

  if (rows && rows.length) {
    return true; // Duplicate exists
  }
  return false; // No duplicate
}

/* -------- Main CRUD Operations -------- */

async function createFoodMenuItem(payload) {
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

    // Validate and process inputs
    const bizId = toNumber(business_id, "Business ID");
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

    // Validate business exists
    await validateBusinessExists(bizId);

    // Validate category exists and is allowed for this business
    await validateCategoryAllowedForBusiness(bizId, catNameLower);

    // FIXED: Check for duplicate BEFORE trying to insert
    const isDuplicate = await checkDuplicateItem(bizId, catNameLower, itemName);
    if (isDuplicate) {
      return {
        success: false,
        message: `Item "${itemName}" already exists in category "${catName}". Please use a different item name.`,
      };
    }

    // Create the food item
    const result = await prisma.food_menu.create({
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

    const createdItem = await getFoodMenuItemById(result.id);

    return {
      success: true,
      message: "Food item created successfully.",
      data: createdItem.data,
    };
  } catch (error) {
    console.error("Create food item error:", error);

    // Handle Prisma unique constraint error as fallback
    if (error.code === "P2002") {
      return {
        success: false,
        message: `Item already exists. Please use a different item name.`,
      };
    }

    return {
      success: false,
      message: error.message || "Failed to create food item. Please try again.",
    };
  }
}

async function getFoodMenuItemById(id) {
  try {
    const item = await prisma.food_menu.findUnique({
      where: { id: id },
    });

    if (!item) {
      return {
        success: false,
        message: `Food item with ID ${id} was not found. Please check the ID and try again.`,
      };
    }

    return {
      success: true,
      data: {
        ...item,
        is_veg: item.is_veg ? 1 : 0,
        is_available: item.is_available ? 1 : 0,
      },
    };
  } catch (error) {
    console.error("Get food item error:", error);
    return {
      success: false,
      message: "Failed to fetch food item. Please try again.",
    };
  }
}

async function listFoodMenuItems({ business_id, category_name } = {}) {
  try {
    const whereCondition = {};

    if (business_id) {
      whereCondition.business_id = toNumber(business_id, "Business ID");
    }

    if (category_name) {
      whereCondition.category_name = category_name.toLowerCase();
    }

    const rows = await prisma.food_menu.findMany({
      where: whereCondition,
      orderBy: [{ sort_order: "asc" }, { item_name: "asc" }],
    });

    const formattedRows = rows.map((item) => ({
      ...item,
      is_veg: item.is_veg ? 1 : 0,
      is_available: item.is_available ? 1 : 0,
    }));

    return {
      success: true,
      data: formattedRows,
      count: formattedRows.length,
    };
  } catch (error) {
    console.error("List food items error:", error);
    return {
      success: false,
      message: "Failed to fetch food items. Please try again.",
    };
  }
}

async function listFoodMenuByBusiness(business_id) {
  try {
    const bizId = toNumber(business_id, "Business ID");
    await validateBusinessExists(bizId);

    const rows = await prisma.food_menu.findMany({
      where: { business_id: bizId },
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
    }));

    return {
      success: true,
      data: formattedRows,
      count: formattedRows.length,
    };
  } catch (error) {
    console.error("List business food items error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch food items for this business.",
    };
  }
}

async function updateFoodMenuItem(id, fields) {
  try {
    const existing = await getFoodMenuItemById(id);
    if (!existing.success) {
      return existing;
    }

    const prev = existing.data;
    const updates = {};

    if ("business_id" in fields) {
      const bizId = toNumber(fields.business_id, "Business ID");
      await validateBusinessExists(bizId);
      updates.business_id = bizId;
    }

    if ("category_name" in fields) {
      const cat = toStrOrNull(fields.category_name);
      if (!cat) throw new Error("Category name cannot be empty.");
      const finalBiz = updates.business_id ?? prev.business_id;
      await validateCategoryAllowedForBusiness(finalBiz, cat.toLowerCase());
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

    // Check for duplicate if name or category changed
    const finalBiz = updates.business_id ?? prev.business_id;
    const finalCat = updates.category_name ?? prev.category_name;
    const finalName = updates.item_name ?? prev.item_name;

    if (finalName !== prev.item_name || finalCat !== prev.category_name) {
      const isDuplicate = await checkDuplicateItem(
        finalBiz,
        finalCat,
        finalName,
        id,
      );
      if (isDuplicate) {
        return {
          success: false,
          message: `Item "${finalName}" already exists in category "${finalCat}". Please use a different item name.`,
        };
      }
    }

    if (Object.keys(updates).length === 0) {
      return {
        success: true,
        message: "No changes were made to the food item.",
        data: prev,
      };
    }

    await prisma.food_menu.update({
      where: { id: id },
      data: {
        ...updates,
        updated_at: new Date(),
      },
    });

    const updatedItem = await getFoodMenuItemById(id);

    return {
      success: true,
      message: "Food item updated successfully.",
      data: updatedItem.data,
      old_image: prev.item_image,
      new_image: updatedItem.data.item_image,
    };
  } catch (error) {
    console.error("Update food item error:", error);
    return {
      success: false,
      message: error.message || "Failed to update food item. Please try again.",
    };
  }
}

async function deleteFoodMenuItem(id) {
  try {
    const existing = await getFoodMenuItemById(id);
    if (!existing.success) {
      return existing;
    }

    await prisma.food_menu.delete({
      where: { id: id },
    });

    return {
      success: true,
      message: "Food item deleted successfully.",
      deleted_item: existing.data,
    };
  } catch (error) {
    console.error("Delete food item error:", error);
    return {
      success: false,
      message: error.message || "Failed to delete food item. Please try again.",
    };
  }
}

// Add missing helper functions
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

module.exports = {
  createFoodMenuItem,
  getFoodMenuItemById,
  listFoodMenuItems,
  listFoodMenuByBusiness,
  updateFoodMenuItem,
  deleteFoodMenuItem,
};
