const { prisma } = require("../lib/prisma");

function toBizIdOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("Business ID must be a positive integer.");
  return n;
}

async function assertBusinessExists(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    select: { business_id: true, min_amount_for_fd: true },
  });

  if (!business) {
    throw new Error(
      `Business with ID ${business_id} does not exist. Please check the business ID.`,
    );
  }
  return business;
}

/**
 * Flow:
 * 1) From business → merchant_business_types → business_types (types='mart') → names
 * 2) From mart_category: categories whose business_type IN (those names)
 * 3) From mart_menu: all items for this business across those categories
 * 4) Group items under their category
 * 5) Exclude categories with zero items
 */
async function getMartMenuGroupedByCategoryForBusiness(business_id) {
  try {
    const bid = toBizIdOrThrow(business_id);

    // Get business row (also has min_amount_for_fd)
    const business = await assertBusinessExists(bid);
    const minFD = Number(business.min_amount_for_fd || 0);

    // 1) Get all merchant business types for this business
    const merchantBusinessTypes = await prisma.merchant_business_types.findMany(
      {
        where: {
          business_id: bid,
        },
        include: {
          business_types: {
            select: { id: true, name: true, types: true },
          },
        },
      },
    );

    // Filter in JavaScript to get only MART types
    const martTypes = merchantBusinessTypes.filter(
      (mbt) => mbt.business_types?.types?.toLowerCase() === "mart",
    );

    if (!martTypes.length) {
      return {
        success: true,
        data: [],
        meta: {
          business_id: bid,
          min_amount_for_fd: minFD,
          categories_count: 0,
          items_count: 0,
        },
      };
    }

    const btNames = martTypes
      .map((mbt) => mbt.business_types?.name)
      .filter(Boolean);

    if (!btNames.length) {
      return {
        success: true,
        data: [],
        meta: {
          business_id: bid,
          min_amount_for_fd: minFD,
          categories_count: 0,
          items_count: 0,
        },
      };
    }

    // 2) Get all categories first, then filter in JavaScript
    const allCategories = await prisma.mart_category.findMany({
      orderBy: { category_name: "asc" },
      select: {
        id: true,
        category_name: true,
        business_type: true,
        description: true,
        category_image: true,
      },
    });

    // Filter categories by business_type matching btNames (case-insensitive)
    const btNamesLower = btNames.map((n) => n.toLowerCase());
    const categories = allCategories.filter((cat) =>
      btNamesLower.includes(cat.business_type?.toLowerCase()),
    );

    if (!categories.length) {
      return {
        success: true,
        data: [],
        meta: {
          business_id: bid,
          min_amount_for_fd: minFD,
          categories_count: 0,
          items_count: 0,
        },
      };
    }

    const catNames = categories.map((c) => c.category_name);

    // 3) Get all mart menu items for this business WITH product info
    // REMOVED select, ONLY using include
    const allItems = await prisma.mart_menu.findMany({
      where: {
        business_id: bid,
      },
      include: {
        mart_product_info: true, // Include product info for sizes and images
      },
      orderBy: [{ sort_order: "asc" }, { item_name: "asc" }],
    });

    // Filter items to only those in allowed categories
    const catNamesLower = catNames.map((n) => n.toLowerCase());
    const filteredItems = allItems.filter((item) =>
      catNamesLower.includes((item.category_name || "").toLowerCase()),
    );

    // Format items (convert boolean to 0/1) and include product_info
    const formattedItems = filteredItems.map((item) => ({
      id: item.id,
      business_id: item.business_id,
      category_name: item.category_name,
      item_name: item.item_name,
      description: item.description,
      item_image: item.item_image,
      actual_price: Number(item.actual_price),
      discount_percentage: Number(item.discount_percentage),
      tax_rate: Number(item.tax_rate),
      is_veg: item.is_veg ? 1 : 0,
      spice_level: item.spice_level,
      is_available: item.is_available ? 1 : 0,
      stock_limit: item.stock_limit,
      sort_order: item.sort_order,
      created_at: item.created_at,
      updated_at: item.updated_at,
      // Include product info if exists, otherwise null
      product_info: item.mart_product_info || null,
    }));

    // Group items under categories
    const itemsByCategory = new Map();
    for (const item of formattedItems) {
      const key = (item.category_name || "").toLowerCase();
      if (!itemsByCategory.has(key)) {
        itemsByCategory.set(key, []);
      }
      itemsByCategory.get(key).push(item);
    }

    // Build grouped response (only include categories that have items)
    const grouped = [];
    for (const cat of categories) {
      const key = (cat.category_name || "").toLowerCase();
      const categoryItems = itemsByCategory.get(key) || [];

      if (categoryItems.length > 0) {
        grouped.push({
          category_id: cat.id,
          category_name: cat.category_name,
          business_type: cat.business_type,
          category_image: cat.category_image,
          description: cat.description,
          items: categoryItems, // Now includes product_info
        });
      }
    }

    return {
      success: true,
      data: grouped,
      meta: {
        business_id: bid,
        min_amount_for_fd: minFD,
        categories_count: grouped.length,
        items_count: formattedItems.length,
      },
    };
  } catch (error) {
    console.error("getMartMenuGroupedByCategoryForBusiness error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch mart menu. Please try again.",
      data: [],
      meta: {},
    };
  }
}

module.exports = {
  getMartMenuGroupedByCategoryForBusiness,
};
