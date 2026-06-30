const prisma = require('../../db');

async function listBookings(req, res, next) {
  try {
    const { event_id, screening_id, payment_method, from_date, to_date, q, page = 1, limit = 20 } = req.query;

    const dateFilter = {};
    if (from_date) dateFilter.gte = new Date(from_date);
    if (to_date) dateFilter.lte = new Date(to_date);

    // For organizers, restrict to their own events only
    let allowedEventIds;
    if (req.user.role === 'organizer') {
      const orgEvents = await prisma.events.findMany({
        where: { organizer_id: req.user.organizer_id },
        select: { id: true },
      });
      allowedEventIds = orgEvents.map((e) => e.id);
    }

    const where = {
      ...(allowedEventIds && { event_id: { in: allowedEventIds } }),
      ...(event_id && { event_id }),
      ...(screening_id && { screening_id }),
      ...(payment_method && { payment_method }),
      ...(Object.keys(dateFilter).length && { created_at: dateFilter }),
      ...(q && { OR: [{ id: { contains: q } }, { ticket_code: { contains: q } }] }),
    };

    const [bookings, total] = await prisma.$transaction([
      prisma.event_bookings.findMany({
        where,
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        orderBy: { created_at: 'desc' },
        include: {
          events: { select: { title: true, venue_name: true } },
          event_ticket_tiers: { select: { name: true } },
          users: { select: { user_name: true, email: true, phone: true } },
          event_booking_seats: {
            include: {
              event_seats: { select: { row_label: true, seat_number: true, section: true, category: true } },
            },
          },
        },
      }),
      prisma.event_bookings.count({ where }),
    ]);

    const data = bookings.map((b) => ({
      id: b.id,
      ticket_code: b.ticket_code,
      event_id: b.event_id,
      event_title: b.events.title,
      venue_name: b.events.venue_name,
      screening_id: b.screening_id,
      tier_name: b.event_ticket_tiers.name,
      quantity: b.quantity,
      total_amount: b.total_amount,
      payment_method: b.payment_method,
      payment_status: b.payment_status,
      status: b.status,
      user_name: b.users.user_name,
      user_email: b.users.email,
      user_phone: b.users.phone,
      attendee_names: typeof b.attendee_names === 'string' ? JSON.parse(b.attendee_names) : b.attendee_names,
      created_at: b.created_at,
      event_seats: b.event_booking_seats.map((bs) => ({
        seat_id: bs.seat_id,
        row: bs.event_seats.row_label,
        number: bs.event_seats.seat_number,
        section: bs.event_seats.section,
        category: bs.event_seats.category,
      })),
    }));

    res.json({ success: true, data, total, page: Number(page) });
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const { id } = req.params;

    const b = await prisma.event_bookings.findUnique({
      where: { id },
      include: {
        events: { select: { title: true, venue_name: true, start_at: true } },
        event_ticket_tiers: { select: { name: true } },
        users: { select: { user_name: true, email: true, phone: true } },
        event_screenings: { select: { show_date: true, show_time: true } },
        event_booking_seats: {
          include: {
            event_seats: { select: { row_label: true, seat_number: true, section: true, category: true } },
          },
        },
      },
    });

    if (!b) return res.status(404).json({ success: false, message: 'Booking not found' });

    res.json({
      success: true,
      data: {
        id: b.id,
        ticket_code: b.ticket_code,
        event_id: b.event_id,
        event_title: b.events.title,
        venue_name: b.events.venue_name,
        event_start_at: b.events.start_at,
        screening_id: b.screening_id,
        screening_date: b.event_screenings?.show_date?.toISOString().slice(0, 10) || null,
        screening_time: b.event_screenings?.show_time?.toISOString().slice(11, 16) || null,
        tier_name: b.event_ticket_tiers.name,
        quantity: b.quantity,
        total_amount: b.total_amount,
        payment_method: b.payment_method,
        payment_status: b.payment_status,
        wallet_journal_code: b.wallet_journal_code,
        status: b.status,
        user_name: b.users.user_name,
        user_email: b.users.email,
        user_phone: b.users.phone,
        attendee_names: typeof b.attendee_names === 'string' ? JSON.parse(b.attendee_names) : b.attendee_names,
        created_at: b.created_at,
        event_seats: b.event_booking_seats.map((bs) => ({
          seat_id: bs.seat_id,
          row: bs.event_seats.row_label,
          number: bs.event_seats.seat_number,
          section: bs.event_seats.section,
          category: bs.event_seats.category,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function deleteBooking(req, res, next) {
  try {
    const { id } = req.params;

    const booking = await prisma.event_bookings.findUnique({ where: { id } });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    await prisma.event_bookings.delete({ where: { id } });
    res.json({ success: true, message: 'Booking deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listBookings, getBooking, deleteBooking };
