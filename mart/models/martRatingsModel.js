const { prisma } = require("../lib/prisma");

/* ---------- helpers ---------- */
function toIntOrThrow(v, msg) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(msg);
  return n;
}

function toRatingOrThrow(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new Error("Rating must be a number between 1 and 5.");
  }
  return n;
}

const normStr = (s) => (s == null ? null : String(s).trim());

function makeError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function assertUserExists(user_id) {
  const user = await prisma.users.findUnique({
    where: { user_id: user_id },
    select: { user_id: true },
  });
  if (!user) throw makeError("User not found. Please check the user ID.", 404);
}

async function assertBusinessExists(business_id) {
  const business = await prisma.merchant_business_details.findUnique({
    where: { business_id: business_id },
    select: { business_id: true },
  });
  if (!business)
    throw makeError("Business not found. Please check the business ID.", 404);
}

async function assertUserHasNotRated(business_id, user_id) {
  const existingRating = await prisma.mart_ratings.findFirst({
    where: {
      business_id: business_id,
      user_id: user_id,
    },
    select: { id: true },
  });

  if (existingRating) {
    throw makeError(
      "Thank you! You have already rated this mart. You can only rate once per mart.",
      409,
    );
  }
}

/* ---------- CREATE (only once per user per business) ---------- */
async function insertMartRating({ business_id, user_id, rating, comment }) {
  try {
    const bid = toIntOrThrow(
      business_id,
      "Business ID must be a positive integer.",
    );
    const uid = toIntOrThrow(user_id, "User ID must be a positive integer.");
    const r = toRatingOrThrow(rating);
    const c = normStr(comment);

    await assertUserExists(uid);
    await assertBusinessExists(bid);
    await assertUserHasNotRated(bid, uid);

    // Create the rating
    await prisma.mart_ratings.create({
      data: {
        business_id: bid,
        user_id: uid,
        rating: r,
        comment: c,
      },
    });

    return {
      success: true,
      message:
        "Your rating has been saved successfully. Thank you for your feedback!",
    };
  } catch (error) {
    if (error.code === "P2002") {
      throw makeError(
        "Thank you! You have already rated this mart. You can only rate once per mart.",
        409,
      );
    }
    throw error;
  }
}

/* ---------- LIST + AGGREGATES ---------- */
async function fetchMartRatings(business_id, { page = 1, limit = 20 } = {}) {
  try {
    const bid = toIntOrThrow(
      business_id,
      "Business ID must be a positive integer.",
    );
    await assertBusinessExists(bid);

    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 20));
    const offset = (p - 1) * l;

    // Get all ratings for this business to calculate aggregates
    const allRatings = await prisma.mart_ratings.findMany({
      where: { business_id: bid },
      select: { rating: true, comment: true },
    });

    // Calculate aggregates
    let totalRating = 0;
    let totalRatings = allRatings.length;
    let totalComments = 0;

    for (const r of allRatings) {
      totalRating += r.rating;
      if (r.comment && r.comment.trim()) {
        totalComments++;
      }
    }

    const avgRating = totalRatings > 0 ? totalRating / totalRatings : 0;

    // Get paginated ratings with user details
    const ratings = await prisma.mart_ratings.findMany({
      where: { business_id: bid },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: l,
      select: {
        id: true,
        business_id: true,
        user_id: true,
        rating: true,
        comment: true,
        created_at: true,
        users: {
          select: {
            user_name: true,
          },
        },
      },
    });

    // Format the response
    const formattedRatings = ratings.map((r) => ({
      id: r.id,
      business_id: r.business_id,
      user_id: r.user_id,
      rating: r.rating,
      comment: r.comment,
      created_at: r.created_at,
      user_name: r.users?.user_name || "Anonymous",
    }));

    return {
      success: true,
      data: formattedRatings,
      meta: {
        business_id: bid,
        page: p,
        limit: l,
        avg_rating: parseFloat(avgRating.toFixed(2)),
        total_ratings: totalRatings,
        total_comments: totalComments,
      },
    };
  } catch (error) {
    console.error("fetchMartRatings error:", error);
    throw error;
  }
}

module.exports = { insertMartRating, fetchMartRatings };
