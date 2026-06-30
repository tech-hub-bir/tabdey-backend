const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');

const HOLD_MINUTES = 10;

// GET /events/:id/event_screenings?date=YYYY-MM-DD
async function listScreenings(req, res, next) {
  try {
    const { id: eventId } = req.params;
    const { date } = req.query;

    const where = { event_id: eventId, status: { not: 'cancelled' } };
    if (date) where.show_date = new Date(date);

    const event_screenings = await prisma.event_screenings.findMany({
      where,
      orderBy: [{ show_date: 'asc' }, { show_time: 'asc' }],
      include: {
        event_halls: { select: { id: true, name: true, total_seats: true } },
        _count: { select: { event_seat_holds: true, event_booking_seats: true } },
      },
    });

    // Get confirmed booked seat counts per screening
    const screeningIds = event_screenings.map((s) => s.id);
    const bookedCounts = await prisma.event_booking_seats.groupBy({
      by: ['screening_id'],
      where: {
        screening_id: { in: screeningIds },
        event_bookings: { status: 'confirmed' },
      },
      _count: { seat_id: true },
    });
    const bookedMap = new Map(bookedCounts.map((b) => [b.screening_id, b._count.seat_id]));

    // Get active hold counts per screening
    const holdCounts = await prisma.event_seat_holds.groupBy({
      by: ['screening_id'],
      where: {
        screening_id: { in: screeningIds },
        expires_at: { gt: new Date() },
      },
      _count: { seat_id: true },
    });
    const holdMap = new Map(holdCounts.map((h) => [h.screening_id, h._count.seat_id]));

    // Group by date → hall name → showtimes
    // Structure: { "2026-05-10": { "Hall I": [ {...showtime}, ... ], "Hall II": [...] } }
    const grouped = {};
    const datesSet = new Set();

    for (const s of event_screenings) {
      const dateKey = s.show_date.toISOString().slice(0, 10);
      const hallName = s.event_halls.name;
      const booked = bookedMap.get(s.id) || 0;
      const held = holdMap.get(s.id) || 0;
      const availableSeats = Math.max(0, s.event_halls.total_seats - booked - held);
      const computedStatus = availableSeats === 0 ? 'housefull' : s.status;

      if (!grouped[dateKey]) grouped[dateKey] = {};
      if (!grouped[dateKey][hallName]) {
        grouped[dateKey][hallName] = {
          hall_id: s.event_halls.id,
          hall_name: hallName,
          total_seats: s.event_halls.total_seats,
          shows: [],
        };
      }

      grouped[dateKey][hallName].shows.push({
        id: s.id,
        show_time: s.show_time.toISOString().slice(11, 16), // "HH:MM"
        available_seats: availableSeats,
        status: computedStatus,     // active | housefull
      });

      datesSet.add(dateKey);
    }

    const dates = [...datesSet].sort();

    res.json({ success: true, data: grouped, dates });
  } catch (err) {
    next(err);
  }
}

// GET /event_screenings/:id
async function getScreening(req, res, next) {
  try {
    const screening = await prisma.event_screenings.findUnique({
      where: { id: req.params.id },
      include: {
        events: {
          select: { id: true, title: true, cover_image: true, category: true, venue_name: true, venue_address: true },
        },
        event_halls: { select: { id: true, name: true, total_seats: true } },
      },
    });

    if (!screening) return res.status(404).json({ success: false, message: 'Screening not found' });

    // Count booked + held event_seats for this screening
    const [bookedCount, heldCount] = await Promise.all([
      prisma.event_booking_seats.count({
        where: {
          screening_id: screening.id,
          event_bookings: { status: 'confirmed' },
        },
      }),
      prisma.event_seat_holds.count({
        where: { screening_id: screening.id, expires_at: { gt: new Date() } },
      }),
    ]);

    const availableSeats = screening.event_halls.total_seats - bookedCount - heldCount;

    res.json({
      success: true,
      data: {
        id: screening.id,
        show_date: screening.show_date.toISOString().slice(0, 10),
        show_time: screening.show_time.toISOString().slice(11, 16),
        status: availableSeats === 0 ? 'housefull' : screening.status,
        available_seats: Math.max(0, availableSeats),
        hall: screening.event_halls,
        event: screening.events,
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /event_screenings/:id/event_seats
async function getSeats(req, res, next) {
  try {
    const { id: screeningId } = req.params;
    const userId = req.user?.id ? BigInt(req.user.id) : null;
    const now = new Date();

    const screening = await prisma.event_screenings.findUnique({
      where: { id: screeningId },
      select: { hall_id: true },
    });
    if (!screening) return res.status(404).json({ success: false, message: 'Screening not found' });

    const [event_seats, holds, booked] = await Promise.all([
      prisma.event_seats.findMany({
        where: { hall_id: screening.hall_id },
        orderBy: [{ section: 'asc' }, { row_label: 'asc' }, { seat_number: 'asc' }],
      }),
      prisma.event_seat_holds.findMany({
        where: { screening_id: screeningId, expires_at: { gt: now } },
      }),
      prisma.event_booking_seats.findMany({
        where: { screening_id: screeningId },
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
        status = userId && holdMap.get(seat.id).user_id === userId ? 'held_by_me' : 'held';
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

// POST /event_screenings/:id/event_seats/hold
async function holdSeats(req, res, next) {
  try {
    const { id: screeningId } = req.params;
    const { seat_ids } = req.body;
    const userId = BigInt(req.user.id);

    if (!seat_ids?.length) {
      return res.status(400).json({ success: false, message: 'seat_ids array is required' });
    }

    const screening = await prisma.event_screenings.findUnique({
      where: { id: screeningId },
      select: { id: true, status: true },
    });
    if (!screening) return res.status(404).json({ success: false, message: 'Screening not found' });
    if (screening.status === 'cancelled') {
      return res.status(409).json({ success: false, message: 'This screening has been cancelled' });
    }

    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // Clean expired holds for this screening
      await tx.event_seat_holds.deleteMany({
        where: { screening_id: screeningId, expires_at: { lt: now } },
      });

      // Check conflicts — holds by others
      const conflicts = await tx.event_seat_holds.findMany({
        where: { screening_id: screeningId, seat_id: { in: seat_ids } },
      });
      const otherConflicts = conflicts.filter((c) => c.user_id !== userId);

      // Check confirmed event_bookings
      const booked = await tx.event_booking_seats.findMany({
        where: { screening_id: screeningId, seat_id: { in: seat_ids } },
        include: { event_bookings: { select: { status: true } } },
      });
      const bookedConflicts = booked.filter((b) => b.event_bookings.status === 'confirmed');

      if (otherConflicts.length || bookedConflicts.length) {
        const err = new Error('One or more selected event_seats are already taken');
        err.status = 409; throw err;
      }

      // Release this user's existing holds for this screening
      await tx.event_seat_holds.deleteMany({ where: { screening_id: screeningId, user_id: userId } });

      // Create new holds
      await tx.event_seat_holds.createMany({
        data: seat_ids.map((seat_id) => ({
          id: uuidv4(),
          screening_id: screeningId,
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

// DELETE /event_screenings/:id/event_seats/hold
async function releaseHold(req, res, next) {
  try {
    const { id: screeningId } = req.params;
    const userId = BigInt(req.user.id);

    const { count } = await prisma.event_seat_holds.deleteMany({
      where: { screening_id: screeningId, user_id: userId },
    });

    res.json({ success: true, message: `Released ${count} seat hold(s)` });
  } catch (err) {
    next(err);
  }
}

module.exports = { listScreenings, getScreening, getSeats, holdSeats, releaseHold };
