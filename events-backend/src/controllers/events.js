const prisma = require('../db');

async function listEvents(req, res, next) {
  try {
    const { q, category, city, from_date, to_date, page = 1, limit = 20 } = req.query;

    const where = {
      ...(category && { category }),
      ...(city && { city: { contains: city } }),
      ...(from_date && { start_at: { gte: new Date(from_date) } }),
      ...(to_date && { start_at: { lte: new Date(to_date) } }),
      ...(q && {
        OR: [
          { title: { contains: q } },
          { venue_name: { contains: q } },
        ],
      }),
    };

    const [events, total] = await prisma.$transaction([
      prisma.events.findMany({
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: { start_at: 'asc' },
        select: {
          id: true,
          title: true,
          category: true,
          city: true,
          venue_name: true,
          venue_address: true,
          organizer_name: true,
          cover_image: true,
          start_at: true,
          end_at: true,
          is_live: true,
          event_ticket_tiers: { select: { price: true }, orderBy: { price: 'asc' }, take: 1 },
        },
      }),
      prisma.events.count({ where }),
    ]);

    const data = events.map(({ event_ticket_tiers, ...e }) => ({
      ...e,
      min_price: event_ticket_tiers[0]?.price ?? 0,
    }));

    res.json({ success: true, data, total, page: Number(page) });
  } catch (err) {
    next(err);
  }
}

async function getEvent(req, res, next) {
  try {
    const { event_ticket_tiers, ...event } = await prisma.events.findUnique({
      where: { id: req.params.id },
      include: {
        event_ticket_tiers: {
          select: { id: true, name: true, description: true, price: true, available_seats: true },
          orderBy: { price: 'asc' },
        },
      },
    }) ?? {};

    if (!event?.id) return res.status(404).json({ success: false, message: 'Event not found' });

    // Return as "ticket_tiers" so the frontend key stays consistent
    res.json({ success: true, data: { ...event, ticket_tiers: event_ticket_tiers } });
  } catch (err) {
    next(err);
  }
}

async function getLiveEvent(req, res, next) {
  try {
    const event = await prisma.events.findFirst({
      where: { is_live: true },
      select: {
        id: true, title: true, organizer_name: true,
        venue_name: true, category: true, cover_image: true,
      },
    });

    res.json({ success: true, data: event || null });
  } catch (err) {
    next(err);
  }
}

module.exports = { listEvents, getEvent, getLiveEvent };
