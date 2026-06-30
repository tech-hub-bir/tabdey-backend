const { prisma } = require("../lib/prisma");

function toBizIdOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error("Business ID must be a positive integer.");
  return n;
}

async function assertBusinessExistsAndIsFood(business_id) {
  // Get business details
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    select: {
      business_id: true,
      min_amount_for_fd: true,
      user_id: true,
    },
  });

  if (!business) {
    throw new Error(
      `Business with ID ${business_id} does not exist. Please check the business ID.`,
    );
  }

  // Check if this business is registered under FOOD service type
  // First get all business types for this business
  const merchantBusinessTypes = await prisma.merchant_business_types.findMany({
    where: {
      business_id: business_id,
    },
    include: {
      business_types: true,
    },
  });

  // Filter in JavaScript to check if any type is "food"
  const isFoodBusiness = merchantBusinessTypes.some(
    (mbt) => mbt.business_types?.types?.toLowerCase() === "food",
  );

  if (!isFoodBusiness) {
    throw new Error(
      `Please ensure the business is registered under the FOOD service type to access the menu.`,
    );
  }

  return business;
}

async function getFoodMenuGroupedByCategoryForBusiness(business_id) {
  try {
    const bid = toBizIdOrThrow(business_id);

    // Get business row and validate it's a food business
    const business = await assertBusinessExistsAndIsFood(bid);
    const minFD = Number(business.min_amount_for_fd || 0);

    // 1) Fetch all items for this business
    const itemRows = await prisma.food_menu.findMany({
      where: { business_id: bid },
      orderBy: [{ sort_order: "asc" }, { item_name: "asc" }],
      select: {
        id: true,
        business_id: true,
        category_name: true,
        item_name: true,
        description: true,
        item_image: true,
        actual_price: true,
        discount_percentage: true,
        tax_rate: true,
        is_veg: true,
        spice_level: true,
        is_available: true,
        stock_limit: true,
        sort_order: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!itemRows.length) {
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

    // Format items (convert boolean to 0/1)
    const formattedItems = itemRows.map((item) => ({
      ...item,
      is_veg: item.is_veg ? 1 : 0,
      is_available: item.is_available ? 1 : 0,
      actual_price: Number(item.actual_price),
      discount_percentage: Number(item.discount_percentage),
      tax_rate: Number(item.tax_rate),
    }));

    // 2) Distinct normalized category keys from items
    const norm = (s) =>
      String(s ?? "")
        .trim()
        .toLowerCase();
    const catKeyToOriginal = new Map();
    const catKeys = new Set();

    for (const it of formattedItems) {
      const key = norm(it.category_name);
      if (!key) continue;
      if (!catKeyToOriginal.has(key))
        catKeyToOriginal.set(key, it.category_name || "");
      catKeys.add(key);
    }

    if (!catKeys.size) {
      return {
        success: true,
        data: [
          {
            category_id: null,
            category_name: "Uncategorized",
            business_type: null,
            category_image: null,
            description: null,
            items: formattedItems,
          },
        ],
        meta: {
          business_id: bid,
          min_amount_for_fd: minFD,
          categories_count: 1,
          items_count: formattedItems.length,
        },
      };
    }

    // 3) Enrich with food_category
    const originals = Array.from(catKeyToOriginal.values());
    const normalizedNames = originals.map((n) => norm(n));

    const allCategories = await prisma.food_category.findMany({
      select: {
        id: true,
        category_name: true,
        business_type: true,
        description: true,
        category_image: true,
      },
    });

    const matchedCategories = allCategories.filter((cat) =>
      normalizedNames.includes(norm(cat.category_name)),
    );

    const catMetaByKey = new Map();
    for (const c of matchedCategories) {
      catMetaByKey.set(norm(c.category_name), {
        id: c.id,
        category_name: c.category_name,
        business_type: c.business_type,
        description: c.description,
        category_image: c.category_image,
      });
    }

    // 4) Group items
    const groups = new Map();
    for (const it of formattedItems) {
      const key = norm(it.category_name) || "__uncategorized__";
      if (!groups.has(key)) {
        const meta = catMetaByKey.get(key);
        groups.set(key, {
          category_id: meta?.id ?? null,
          category_name:
            meta?.category_name ??
            (catKeyToOriginal.get(key) || "Uncategorized"),
          business_type: meta?.business_type ?? null,
          category_image: meta?.category_image ?? null,
          description: meta?.description ?? null,
          items: [],
        });
      }
      groups.get(key).items.push(it);
    }

    const grouped = Array.from(groups.values()).sort((a, b) =>
      String(a.category_name).localeCompare(String(b.category_name)),
    );

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
    console.error("getFoodMenuGroupedByCategoryForBusiness error:", error);
    return {
      success: false,
      message: error.message || "Failed to fetch menu. Please try again.",
      data: [],
      meta: {},
    };
  }
}

module.exports = {
  getFoodMenuGroupedByCategoryForBusiness,
};
