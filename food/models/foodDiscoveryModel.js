const { prisma } = require("../lib/prisma");

function toPositiveIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}

async function getFoodBusinessesByBusinessTypeId(business_type_id) {
  try {
    const btId = toPositiveIntOrThrow(
      business_type_id,
      "Business type ID must be a valid positive number.",
    );

    // 1) Validate business_type id belongs to FOOD
    const businessType = await prisma.business_types.findUnique({
      where: { id: btId },
      select: { id: true, name: true, types: true },
    });

    if (!businessType) {
      return {
        success: false,
        message: `Business type with ID ${btId} was not found. Please check the ID and try again.`,
        data: [],
      };
    }

    if (String(businessType.types || "").toLowerCase() !== "food") {
      return {
        success: false,
        message: `Business type "${businessType.name}" is not a FOOD service type. Please select a food category.`,
        data: [],
      };
    }

    // 2) Get business_ids mapped to that type
    const merchantBusinessTypes = await prisma.merchant_business_types.findMany(
      {
        where: { business_type_id: btId },
        select: { business_id: true },
        distinct: ["business_id"],
      },
    );

    if (!merchantBusinessTypes.length) {
      return {
        success: true,
        data: [],
        meta: {
          kind: "food",
          business_type_id: btId,
          business_type_name: businessType.name,
          businesses_count: 0,
        },
      };
    }

    const bizIds = merchantBusinessTypes.map((item) => item.business_id);

    // 3) Fetch businesses with their details
    const businesses = await prisma.merchant_business_details.findMany({
      where: {
        business_id: { in: bizIds },
      },
      select: {
        business_id: true,
        business_name: true,
        address: true,
        business_logo: true,
        opening_time: true,
        closing_time: true,
        delivery_option: true,
        complementary: true,
        complementary_details: true,
        latitude: true,
        longitude: true,
        food_ratings: {
          select: {
            rating: true,
            comment: true,
          },
        },
      },
    });

    // Calculate aggregates for each business
    const formattedBusinesses = businesses.map((business) => {
      let totalRating = 0;
      let totalRatings = 0;
      let totalComments = 0;

      // Calculate ratings from food_ratings
      if (business.food_ratings && business.food_ratings.length) {
        for (const rating of business.food_ratings) {
          totalRating += rating.rating;
          totalRatings++;
          if (rating.comment && rating.comment.trim()) {
            totalComments++;
          }
        }
      }

      const avgRating = totalRatings > 0 ? totalRating / totalRatings : 0;

      return {
        business_id: Number(business.business_id),
        business_name: business.business_name,
        address: business.address,
        business_logo: business.business_logo,
        opening_time: business.opening_time,
        closing_time: business.closing_time,
        delivery_option: business.delivery_option,
        complementary: business.complementary,
        complementary_details: business.complementary_details,
        latitude: business.latitude ? parseFloat(business.latitude) : null,
        longitude: business.longitude ? parseFloat(business.longitude) : null,
        avg_rating: parseFloat(avgRating.toFixed(2)),
        total_ratings: totalRatings,
        total_comments: totalComments,
      };
    });

    // Sort by avg_rating DESC, total_comments DESC, business_name ASC
    formattedBusinesses.sort((a, b) => {
      if (a.avg_rating !== b.avg_rating) {
        return b.avg_rating - a.avg_rating;
      }
      if (a.total_comments !== b.total_comments) {
        return b.total_comments - a.total_comments;
      }
      return a.business_name.localeCompare(b.business_name);
    });

    return {
      success: true,
      data: formattedBusinesses,
      meta: {
        kind: "food",
        business_type_id: btId,
        business_type_name: businessType.name,
        businesses_count: formattedBusinesses.length,
      },
    };
  } catch (error) {
    console.error("getFoodBusinessesByBusinessTypeId error:", error);
    return {
      success: false,
      message:
        error.message || "Failed to fetch food businesses. Please try again.",
      data: [],
    };
  }
}

module.exports = {
  getFoodBusinessesByBusinessTypeId,
};
