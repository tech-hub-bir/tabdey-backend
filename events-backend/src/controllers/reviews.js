const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');

// GET /events/:id/reviews?page=1&limit=10&sort=recent&rating=0
async function getReviews(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const page    = Number(req.query.page)   || 1;
    const limit   = Number(req.query.limit)  || 10;
    const sort    = req.query.sort   || 'recent';   // recent | highest | lowest | helpful
    const rating  = Number(req.query.rating) || 0;  // 0 = all, 1–5 = filter by star
    const userId  = req.user?.id ? BigInt(req.user.id) : null;

    const where = {
      event_id: eventId,
      ...(rating >= 1 && rating <= 5 && { rating }),
    };

    const orderBy = {
      recent:  { created_at: 'desc' },
      highest: { rating: 'desc' },
      lowest:  { rating: 'asc' },
      helpful: { event_review_helpful: { _count: 'desc' } },
    }[sort] ?? { created_at: 'desc' };

    // Run all queries in parallel
    const [reviews, agg, breakdown, userReview] = await Promise.all([
      // Paginated review list
      prisma.event_reviews.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          users: { select: { user_name: true, profile_image: true } },
          _count: { select: { event_review_helpful: true } },
          ...(userId && {
            event_review_helpful: { where: { user_id: userId }, select: { user_id: true } },
          }),
        },
      }),

      // Overall stats
      prisma.event_reviews.aggregate({
        where: { event_id: eventId },
        _avg: { rating: true },
        _count: { rating: true },
      }),

      // Star breakdown: how many 1★, 2★, 3★, 4★, 5★
      prisma.event_reviews.groupBy({
        by: ['rating'],
        where: { event_id: eventId },
        _count: { rating: true },
      }),

      // Current user's own review (if logged in)
      userId
        ? prisma.event_reviews.findUnique({
            where: { event_id_user_id: { event_id: eventId, user_id: userId } },
            select: { id: true, rating: true, comment: true, created_at: true },
          })
        : null,
    ]);

    // Format breakdown: { "1": 5, "2": 8, "3": 15, "4": 32, "5": 60 }
    const ratingBreakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    breakdown.forEach((b) => { ratingBreakdown[b.rating] = b._count.rating; });

    const total = agg._count.rating;
    const avgRating = parseFloat((agg._avg.rating ?? 0).toFixed(1));

    // Compute percentage per star
    const ratingPercentage = {};
    for (let s = 1; s <= 5; s++) {
      ratingPercentage[s] = total > 0 ? Math.round((ratingBreakdown[s] / total) * 100) : 0;
    }

    res.json({
      success: true,
      summary: {
        avg_rating: avgRating,
        total_reviews: total,
        breakdown: ratingBreakdown,       // raw counts per star
        percentage: ratingPercentage,     // % per star for progress bars
      },
      user_review: userReview || null,    // logged-in user's own review
      data: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        user_name: r.users.user_name,
        user_image: r.users.profile_image,
        helpful_count: r._count.event_review_helpful,
        is_helpful_by_me: userId ? r.event_review_helpful?.length > 0 : false,
        created_at: r.created_at,
      })),
      page,
      total_pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
}

// POST /events/:id/reviews
async function submitReview(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const { rating, comment } = req.body;
    const userId  = BigInt(req.user.id);
    const userName = req.user.name || 'Anonymous';

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
    }

    const review = await prisma.event_reviews.upsert({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
      update: { rating, comment },
      create: { id: uuidv4(), event_id: eventId, user_id: userId, rating, comment },
    });

    // Recompute event avg_rating and total_reviews
    const agg = await prisma.event_reviews.aggregate({
      where: { event_id: eventId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await prisma.events.update({
      where: { id: eventId },
      data: {
        avg_rating: agg._avg.rating ?? 0,
        total_reviews: agg._count.rating,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        user_name: userName,
        created_at: review.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /events/:id/reviews
async function deleteReview(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const userId = BigInt(req.user.id);

    const review = await prisma.event_reviews.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    });

    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found' });
    }

    await prisma.event_reviews.delete({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    });

    // Recompute avg_rating
    const agg = await prisma.event_reviews.aggregate({
      where: { event_id: eventId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await prisma.events.update({
      where: { id: eventId },
      data: {
        avg_rating: agg._avg.rating ?? 0,
        total_reviews: agg._count.rating,
      },
    });

    res.json({ success: true, message: 'Review deleted' });
  } catch (err) {
    next(err);
  }
}

// POST /events/:id/reviews/:reviewId/helpful
async function toggleHelpful(req, res, next) {
  try {
    const { reviewId } = req.params;
    const userId = BigInt(req.user.id);

    const existing = await prisma.event_review_helpful.findUnique({
      where: { review_id_user_id: { review_id: reviewId, user_id: userId } },
    });

    if (existing) {
      await prisma.event_review_helpful.delete({
        where: { review_id_user_id: { review_id: reviewId, user_id: userId } },
      });
      const count = await prisma.event_review_helpful.count({ where: { review_id: reviewId } });
      return res.json({ success: true, helpful: false, helpful_count: count });
    }

    await prisma.event_review_helpful.create({ data: { review_id: reviewId, user_id: userId } });
    const count = await prisma.event_review_helpful.count({ where: { review_id: reviewId } });

    res.json({ success: true, helpful: true, helpful_count: count });
  } catch (err) {
    next(err);
  }
}

module.exports = { getReviews, submitReview, deleteReview, toggleHelpful };
