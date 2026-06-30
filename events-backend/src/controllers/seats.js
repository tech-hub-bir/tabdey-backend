const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');

const HOLD_MINUTES = 10;

async function getHalls(req, res, next) {
  try {
    const event = await prisma.events.findUnique({
      where: { id: req.params.id },
      select: { venue_name: true },
    });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    const event_halls = await prisma.event_halls.findMany({
      where: { venue_name: event.venue_name },
      select: { id: true, name: true, total_seats: true },
    });

    res.json({ success: true, data: event_halls });
  } catch (err) {
    next(err);
  }
}

async function getSeats(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const { hall_id } = req.query;
    if (!hall_id) return res.status(400).json({ success: false, message: 'hall_id is required' });

    const userId = req.user?.id ? BigInt(req.user.id) : null;
    const now = new Date();

    const [event_seats, holds, booked] = await Promise.all([
      prisma.event_seats.findMany({
        where: { hall_id },
        orderBy: [{ section: 'asc' }, { row_label: 'asc' }, { seat_number: 'asc' }],
      }),
      prisma.event_seat_holds.findMany({
        where: { event_id: eventId, expires_at: { gt: now } },
      }),
      prisma.event_booking_seats.findMany({
        where: { event_id: eventId },
        include: { event_bookings: { select: { status: true } } },
      }),
    ]);

    const holdMap = new Map(holds.map((h) => [h.seat_id, h]));
    const bookedSet = new Set(
      booked.filter((b) => b.event_bookings.status === 'confirmed').map((b) => b.seat_id)
    );

    const withStatus = event_seats.map((seat) => {
      let status = 'available';
      if (bookedSet.has(seat.id)) {
        status = 'booked';
      } else if (holdMap.has(seat.id)) {
        const hold = holdMap.get(seat.id);
        status = userId && hold.user_id === userId ? 'held_by_me' : 'held';
      }
      return { ...seat, status };
    });

    // Group by section → row
    const grouped = {};
    for (const seat of withStatus) {
      if (!grouped[seat.section]) grouped[seat.section] = {};
      if (!grouped[seat.section][seat.row_label]) grouped[seat.section][seat.row_label] = [];
      grouped[seat.section][seat.row_label].push({
        id: seat.id,
        seat_number: seat.seat_number,
        column_position: seat.column_position,
        category: seat.category,
        status: seat.status,
      });
    }

    res.json({ success: true, data: grouped });
  } catch (err) {
    next(err);
  }
}

async function holdSeats(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const { seat_ids } = req.body;
    const userId = BigInt(req.user.id);

    if (!seat_ids?.length) {
      return res.status(400).json({ success: false, message: 'seat_ids array is required' });
    }

    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // Clean up expired holds for this event
      await tx.event_seat_holds.deleteMany({
        where: { event_id: eventId, expires_at: { lt: now } },
      });

      // Check for active holds by others
      const conflicts = await tx.event_seat_holds.findMany({
        where: { event_id: eventId, seat_id: { in: seat_ids } },
      });
      const otherConflicts = conflicts.filter((c) => c.user_id !== userId);

      // Check for confirmed event_bookings
      const booked = await tx.event_booking_seats.findMany({
        where: { event_id: eventId, seat_id: { in: seat_ids } },
        include: { event_bookings: { select: { status: true } } },
      });
      const bookedConflicts = booked.filter((b) => b.event_bookings.status === 'confirmed');

      if (otherConflicts.length || bookedConflicts.length) {
        const err = new Error('One or more selected event_seats are already taken');
        err.status = 409;
        throw err;
      }

      // Release current user's existing holds for this event
      await tx.event_seat_holds.deleteMany({ where: { event_id: eventId, user_id: userId } });

      // Create new holds
      await tx.event_seat_holds.createMany({
        data: seat_ids.map((seat_id) => ({
          id: uuidv4(),
          event_id: eventId,
          seat_id,
          user_id: userId,
          expires_at: expiresAt,
        })),
      });
    }, { timeout: 20000 });

    res.json({
      success: true,
      data: {
        held_seats: seat_ids,
        expires_at: expiresAt,
        expires_in_seconds: HOLD_MINUTES * 60,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function releaseHold(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const userId = BigInt(req.user.id);

    const { count } = await prisma.event_seat_holds.deleteMany({
      where: { event_id: eventId, user_id: userId },
    });

    res.json({ success: true, message: `Released ${count} seat hold(s)` });
  } catch (err) {
    next(err);
  }
}

module.exports = { getHalls, getSeats, holdSeats, releaseHold };
