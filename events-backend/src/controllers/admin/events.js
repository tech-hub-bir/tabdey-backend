const { v4: uuidv4 } = require('uuid');
const prisma = require('../../db');

async function listEvents(req, res, next) {
  try {
    const { q, category, city, organizer_id, from_date, to_date, sort = 'start_at', page = 1, limit = 20 } = req.query;

    const where = {
      ...(category && { category }),
      ...(city && { city: { contains: city } }),
      ...(organizer_id && { organizer_id }),
      ...(from_date && { start_at: { gte: new Date(from_date) } }),
      ...(to_date && { start_at: { lte: new Date(to_date) } }),
      ...(q && { OR: [{ title: { contains: q } }, { venue_name: { contains: q } }] }),
      // Scope to own events for organizer role
      ...(req.user.role === 'organizer' && { organizer_id: req.user.organizer_id }),
    };

    const orderByMap = {
      start_at: { start_at: 'asc' },
      created_at: { created_at: 'desc' },
    };

    const [events, total] = await prisma.$transaction([
      prisma.events.findMany({
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: orderByMap[sort] || { start_at: 'asc' },
        include: {
          event_ticket_tiers: { select: { id: true, name: true, price: true, available_seats: true } },
        },
      }),
      prisma.events.count({ where }),
    ]);

    const eventIds = events.map((e) => e.id);
    const revenues = await prisma.event_bookings.groupBy({
      by: ['event_id'],
      where: { event_id: { in: eventIds }, status: 'confirmed' },
      _sum: { total_amount: true, quantity: true },
      _count: { id: true },
    });
    const revenueMap = new Map(revenues.map((r) => [r.event_id, r]));

    const data = events.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      city: e.city,
      venue_name: e.venue_name,
      organizer_name: e.organizer_name,
      cover_image: e.cover_image,
      start_at: e.start_at,
      end_at: e.end_at,
      is_live: e.is_live,
      avg_rating: e.avg_rating,
      total_reviews: e.total_reviews,
      created_at: e.created_at,
      ticket_tiers: e.event_ticket_tiers,
      booking_count: revenueMap.get(e.id)?._count.id || 0,
      tickets_sold: revenueMap.get(e.id)?._sum.quantity || 0,
      gross_revenue: revenueMap.get(e.id)?._sum.total_amount || 0,
    }));

    res.json({ success: true, data, total, page: Number(page) });
  } catch (err) {
    next(err);
  }
}

async function createEvent(req, res, next) {
  try {
    const { title, category, city, venue_name, venue_address, organizer_name, organizer_id, cover_image, description, start_at, end_at, is_live = false } = req.body;

    if (!title || !category || !city || !venue_name || !start_at || !end_at) {
      return res.status(400).json({ success: false, message: 'title, category, city, venue_name, start_at, end_at are required' });
    }

    const event = await prisma.events.create({
      data: {
        id: uuidv4(),
        title, category, city, venue_name,
        venue_address: venue_address || null,
        organizer_name: organizer_name || null,
        organizer_id: organizer_id || null,
        cover_image: cover_image || null,
        description: description || null,
        start_at: new Date(start_at),
        end_at: new Date(end_at),
        is_live: Boolean(is_live),
      },
    });

    res.status(201).json({ success: true, data: event });
  } catch (err) {
    next(err);
  }
}

async function updateEvent(req, res, next) {
  try {
    const { id } = req.params;
    const { title, category, city, venue_name, venue_address, organizer_name, organizer_id, cover_image, description, start_at, end_at, is_live } = req.body;

    const event = await prisma.events.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    const updated = await prisma.events.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(category !== undefined && { category }),
        ...(city !== undefined && { city }),
        ...(venue_name !== undefined && { venue_name }),
        ...(venue_address !== undefined && { venue_address }),
        ...(organizer_name !== undefined && { organizer_name }),
        ...(organizer_id !== undefined && { organizer_id }),
        ...(cover_image !== undefined && { cover_image }),
        ...(description !== undefined && { description }),
        ...(start_at !== undefined && { start_at: new Date(start_at) }),
        ...(end_at !== undefined && { end_at: new Date(end_at) }),
        ...(is_live !== undefined && { is_live: Boolean(is_live) }),
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

async function deleteEvent(req, res, next) {
  try {
    const { id } = req.params;
    const { force } = req.query;

    const event = await prisma.events.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    if (force !== 'true') {
      const confirmedCount = await prisma.event_bookings.count({ where: { event_id: id, status: 'confirmed' } });
      if (confirmedCount > 0) {
        return res.status(409).json({
          success: false,
          message: `${confirmedCount} confirmed booking(s) exist. Add ?force=true to override.`,
          confirmed_bookings: confirmedCount,
        });
      }
    }

    await prisma.events.delete({ where: { id } });
    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    next(err);
  }
}

async function toggleLive(req, res, next) {
  try {
    const { id } = req.params;

    const event = await prisma.events.findUnique({ where: { id } });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    await prisma.$transaction([
      prisma.events.updateMany({ where: { is_live: true }, data: { is_live: false } }),
      prisma.events.update({ where: { id }, data: { is_live: true } }),
    ]);

    res.json({ success: true, message: `"${event.title}" is now the live event.` });
  } catch (err) {
    next(err);
  }
}

module.exports = { listEvents, createEvent, updateEvent, deleteEvent, toggleLive };
