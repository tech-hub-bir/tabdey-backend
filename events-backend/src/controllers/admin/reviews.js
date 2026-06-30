const prisma = require('../../db');

async function listReviews(req, res, next) {
  try {
    const { eventId } = req.params;
    const { page = 1, limit = 20, rating } = req.query;

    const where = {
      event_id: eventId,
      ...(rating && { rating: Number(rating) }),
    };

    const [reviews, total, agg] = await Promise.all([
      prisma.event_reviews.findMany({
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: { created_at: 'desc' },
        include: {
          users: { select: { user_name: true, email: true } },
          _count: { select: { event_review_helpful: true } },
        },
      }),
      prisma.event_reviews.count({ where }),
      prisma.event_reviews.aggregate({
        where: { event_id: eventId },
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    res.json({
      success: true,
      summary: {
        avg_rating: parseFloat((agg._avg.rating ?? 0).toFixed(1)),
        total_reviews: agg._count.rating,
      },
      data: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        user_name: r.users.user_name,
        user_email: r.users.email,
        helpful_count: r._count.event_review_helpful,
        created_at: r.created_at,
      })),
      page: Number(page),
      total_pages: Math.ceil(total / Number(limit)),
    });
  } catch (err) {
    next(err);
  }
}

async function deleteReview(req, res, next) {
  try {
    const { reviewId } = req.params;

    const review = await prisma.event_reviews.findUnique({ where: { id: reviewId }, include: { events: { select: { organizer_id: true } } } });
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    if (req.user.role === 'organizer' && review.events.organizer_id !== req.user.organizer_id) {
      return res.status(403).json({ success: false, message: 'Forbidden: this review does not belong to your event' });
    }

    await prisma.event_reviews.delete({ where: { id: reviewId } });

    const agg = await prisma.event_reviews.aggregate({
      where: { event_id: review.event_id },
      _avg: { rating: true },
      _count: { rating: true },
    });
    await prisma.events.update({
      where: { id: review.event_id },
      data: { avg_rating: agg._avg.rating ?? 0, total_reviews: agg._count.rating },
    });

    res.json({ success: true, message: 'Review deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listReviews, deleteReview };
