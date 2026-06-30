const prisma = require("../../db");

async function getSummary(req, res, next) {
  try {
    const { from_date, to_date } = req.query;

    const dateFilter = {};
    if (from_date) dateFilter.gte = new Date(from_date);
    if (to_date) dateFilter.lte = new Date(to_date);
    let eventIdFilter;
    if (req.user.role === 'organizer') {
      const orgEvents = await prisma.events.findMany({
        where: { organizer_id: req.user.organizer_id },
        select: { id: true },
      });
      eventIdFilter = { in: orgEvents.map((e) => e.id) };
    }

    const where = {
      status: "confirmed",
      ...(eventIdFilter && { event_id: eventIdFilter }),
      ...(Object.keys(dateFilter).length && { created_at: dateFilter }),
    };

    const [totals, byPaymentMethod, bookingsRaw] = await Promise.all([
      prisma.event_bookings.aggregate({
        where,
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ["payment_method"],
        where,
        _sum: { total_amount: true },
        _count: { id: true },
      }),
      prisma.event_bookings.findMany({
        where,
        select: { event_id: true, total_amount: true },
      }),
    ]);

    // Category breakdown via in-memory join
    const eventIds = [...new Set(bookingsRaw.map((b) => b.event_id))];
    const events = await prisma.events.findMany({
      where: { id: { in: eventIds } },
      select: { id: true, category: true },
    });
    const categoryMap = new Map(events.map((e) => [e.id, e.category]));
    const byCategoryMap = {};
    for (const b of bookingsRaw) {
      const cat = categoryMap.get(b.event_id) || "unknown";
      if (!byCategoryMap[cat])
        byCategoryMap[cat] = { revenue: 0, booking_count: 0 };
      byCategoryMap[cat].revenue += b.total_amount;
      byCategoryMap[cat].booking_count += 1;
    }

    // Daily trend via parameterized raw query
    const fromTs = from_date ? new Date(from_date) : new Date("2020-01-01");
    const toTs = to_date ? new Date(to_date) : new Date("2099-12-31");
    const dailyTrend = await prisma.$queryRaw`
      SELECT DATE(created_at) AS date,
             CAST(SUM(total_amount) AS SIGNED) AS revenue,
             CAST(COUNT(id) AS SIGNED) AS bookings
      FROM event_bookings
      WHERE status = 'confirmed'
        AND created_at >= ${fromTs}
        AND created_at <= ${toTs}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;

    res.json({
      success: true,
      data: {
        gross_revenue: totals._sum.total_amount || 0,
        tickets_sold: totals._sum.quantity || 0,
        total_bookings: totals._count.id,
        avg_ticket_value:
          totals._count.id > 0
            ? Math.round((totals._sum.total_amount || 0) / totals._count.id)
            : 0,
        by_payment_method: byPaymentMethod.map((r) => ({
          method: r.payment_method,
          revenue: r._sum.total_amount || 0,
          count: r._count.id,
        })),
        by_category: Object.entries(byCategoryMap).map(([category, stats]) => ({
          category,
          ...stats,
        })),
        daily_trend: dailyTrend.map((row) => ({
          date: row.date,
          revenue: Number(row.revenue),
          bookings: Number(row.bookings),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getEventRevenue(req, res, next) {
  try {
    const { id } = req.params;

    const event = await prisma.events.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        category: true,
        venue_name: true,
        start_at: true,
      },
    });
    if (!event)
      return res
        .status(404)
        .json({ success: false, message: "Event not found" });

    const bookingWhere = { event_id: id, status: "confirmed" };

    const [totals, byTier, byPaymentMethod, screenings] = await Promise.all([
      prisma.event_bookings.aggregate({
        where: bookingWhere,
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ["tier_id"],
        where: bookingWhere,
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ["payment_method"],
        where: bookingWhere,
        _sum: { total_amount: true },
        _count: { id: true },
      }),
      prisma.event_screenings.findMany({
        where: { event_id: id },
        include: { event_halls: { select: { name: true, total_seats: true } } },
      }),
    ]);

    // Enrich tier names
    const tierIds = byTier.map((t) => t.tier_id);
    const tiers = await prisma.event_ticket_tiers.findMany({
      where: { id: { in: tierIds } },
      select: { id: true, name: true },
    });
    const tierNameMap = new Map(tiers.map((t) => [t.id, t.name]));

    // Screening occupancy
    const screeningIds = screenings.map((s) => s.id);
    const bookedCounts = await prisma.event_booking_seats.groupBy({
      by: ["screening_id"],
      where: {
        screening_id: { in: screeningIds },
        event_bookings: { status: "confirmed" },
      },
      _count: { seat_id: true },
    });
    const bookedMap = new Map(
      bookedCounts.map((b) => [b.screening_id, b._count.seat_id]),
    );

    const screeningOccupancy = screenings.map((s) => {
      const booked = bookedMap.get(s.id) || 0;
      const total = s.event_halls.total_seats;
      return {
        id: s.id,
        show_date: s.show_date.toISOString().slice(0, 10),
        show_time: s.show_time.toISOString().slice(11, 16),
        hall_name: s.event_halls.name,
        total_seats: total,
        booked_seats: booked,
        occupancy_pct: total > 0 ? Math.round((booked / total) * 1000) / 10 : 0,
        status: s.status,
      };
    });

    res.json({
      success: true,
      data: {
        event,
        gross_revenue: totals._sum.total_amount || 0,
        tickets_sold: totals._sum.quantity || 0,
        total_bookings: totals._count.id,
        avg_ticket_value:
          totals._count.id > 0
            ? Math.round((totals._sum.total_amount || 0) / totals._count.id)
            : 0,
        by_tier: byTier.map((t) => ({
          tier_id: t.tier_id,
          tier_name: tierNameMap.get(t.tier_id) || "Unknown",
          revenue: t._sum.total_amount || 0,
          tickets_sold: t._sum.quantity || 0,
          booking_count: t._count.id,
        })),
        by_payment_method: byPaymentMethod.map((r) => ({
          method: r.payment_method,
          revenue: r._sum.total_amount || 0,
          count: r._count.id,
        })),
        screening_occupancy: screeningOccupancy,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getPaymentSessions(req, res, next) {
  try {
    const { status, from_date, to_date, page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const dateFilter = {};
    if (from_date) dateFilter.gte = new Date(from_date);
    if (to_date) dateFilter.lte = new Date(to_date);

    // For organizers, get their event IDs and filter via JSON_EXTRACT raw SQL
    let allowedEventIds = null;
    if (req.user.role === 'organizer') {
      const orgEvents = await prisma.events.findMany({
        where: { organizer_id: req.user.organizer_id },
        select: { id: true },
      });
      allowedEventIds = orgEvents.map((e) => e.id);
      if (allowedEventIds.length === 0) {
        return res.json({ success: true, data: [], total: 0, page: Number(page) });
      }
    }

    const where = {
      ...(status && { status }),
      ...(Object.keys(dateFilter).length && { created_at: dateFilter }),
    };

    // Fetch sessions and total count separately (avoids $transaction timeout)
    let sessions, total;

    if (allowedEventIds) {
      // Use raw query for JSON_EXTRACT filtering on organizer's event IDs
      const placeholders = allowedEventIds.map(() => '?').join(', ');
      const statusClause = status ? `AND status = ?` : '';
      const fromClause = from_date ? `AND created_at >= ?` : '';
      const toClause = to_date ? `AND created_at <= ?` : '';

      const baseArgs = [
        ...allowedEventIds,
        ...(status ? [status] : []),
        ...(from_date ? [new Date(from_date)] : []),
        ...(to_date ? [new Date(to_date)] : []),
      ];

      sessions = await prisma.$queryRawUnsafe(
        `SELECT eps.*, u.user_name, u.email AS user_email
         FROM event_payment_sessions eps
         JOIN users u ON u.user_id = eps.user_id
         WHERE JSON_EXTRACT(eps.payment_context, '$.event_id') IN (${placeholders})
         ${statusClause} ${fromClause} ${toClause}
         ORDER BY eps.created_at DESC
         LIMIT ? OFFSET ?`,
        ...baseArgs, take, skip
      );

      const [countRow] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) AS total
         FROM event_payment_sessions eps
         WHERE JSON_EXTRACT(eps.payment_context, '$.event_id') IN (${placeholders})
         ${statusClause} ${fromClause} ${toClause}`,
        ...baseArgs
      );
      total = Number(countRow.total);
    } else {
      sessions = await prisma.event_payment_sessions.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: { users: { select: { user_name: true, email: true } } },
      });
      total = await prisma.event_payment_sessions.count({ where });
    }

    const data = sessions.map((s) => ({
      id: s.id,
      order_no: s.order_no,
      bfs_txn_id: s.bfs_txn_id,
      amount: Number(s.amount),
      status: s.status,
      user_name: s.user_name,
      user_email: s.user_email || s.users?.email,
      payment_context: s.payment_context,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));

    res.json({ success: true, data, total, page: Number(page) });
  } catch (err) {
    next(err);
  }
}

// ─── CSV helpers ─────────────────────────────────────────────────────────────
function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows, columns) {
  const header = columns.map((c) => escapeCsv(c.label)).join(',');
  const body = rows.map((row) =>
    columns.map((c) => escapeCsv(c.value(row))).join(',')
  );
  return [header, ...body].join('\n');
}

// ─── Export: all bookings as CSV ──────────────────────────────────────────────
// GET /admin/revenue/export?from_date=&to_date=&format=csv
async function exportRevenue(req, res, next) {
  try {
    const { from_date, to_date } = req.query;

    const dateFilter = {};
    if (from_date) dateFilter.gte = new Date(from_date);
    if (to_date) dateFilter.lte = new Date(to_date);

    let eventIdFilter;
    if (req.user.role === 'organizer') {
      const orgEvents = await prisma.events.findMany({
        where: { organizer_id: req.user.organizer_id },
        select: { id: true },
      });
      eventIdFilter = { in: orgEvents.map((e) => e.id) };
    }

    const where = {
      status: 'confirmed',
      ...(eventIdFilter && { event_id: eventIdFilter }),
      ...(Object.keys(dateFilter).length && { created_at: dateFilter }),
    };

    const bookings = await prisma.event_bookings.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        events: { select: { title: true, category: true, venue_name: true } },
        event_ticket_tiers: { select: { name: true } },
        users: { select: { user_name: true, email: true } },
      },
    });

    const columns = [
      { label: 'Booking ID',      value: (r) => r.id },
      { label: 'Event',           value: (r) => r.events?.title },
      { label: 'Category',        value: (r) => r.events?.category },
      { label: 'Venue',           value: (r) => r.events?.venue_name },
      { label: 'Tier',            value: (r) => r.event_ticket_tiers?.name },
      { label: 'Quantity',        value: (r) => r.quantity },
      { label: 'Total Amount',    value: (r) => r.total_amount },
      { label: 'Payment Method',  value: (r) => r.payment_method },
      { label: 'Payment Status',  value: (r) => r.payment_status },
      { label: 'User Name',       value: (r) => r.users?.user_name },
      { label: 'User Email',      value: (r) => r.users?.email },
      { label: 'Ticket Code',     value: (r) => r.ticket_code },
      { label: 'Created At',      value: (r) => r.created_at?.toISOString() },
    ];

    const csv = buildCsv(bookings, columns);
    const filename = `revenue_export_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

// ─── Export: single event bookings as CSV ────────────────────────────────────
// GET /admin/revenue/events/:id/export
async function exportEventRevenue(req, res, next) {
  try {
    const { id } = req.params;

    const event = await prisma.events.findUnique({
      where: { id },
      select: { id: true, title: true, category: true, venue_name: true, start_at: true },
    });
    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    if (req.user.role === 'organizer') {
      const orgEvent = await prisma.events.findFirst({
        where: { id, organizer_id: req.user.organizer_id },
        select: { id: true },
      });
      if (!orgEvent) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
    }

    const bookings = await prisma.event_bookings.findMany({
      where: { event_id: id, status: 'confirmed' },
      orderBy: { created_at: 'desc' },
      include: {
        event_ticket_tiers: { select: { name: true } },
        users: { select: { user_name: true, email: true } },
      },
    });

    const columns = [
      { label: 'Booking ID',      value: (r) => r.id },
      { label: 'Ticket Code',     value: (r) => r.ticket_code },
      { label: 'Tier',            value: (r) => r.event_ticket_tiers?.name },
      { label: 'Quantity',        value: (r) => r.quantity },
      { label: 'Total Amount',    value: (r) => r.total_amount },
      { label: 'Payment Method',  value: (r) => r.payment_method },
      { label: 'Payment Status',  value: (r) => r.payment_status },
      { label: 'User Name',       value: (r) => r.users?.user_name },
      { label: 'User Email',      value: (r) => r.users?.email },
      { label: 'Attendee Names',  value: (r) => {
        try { return JSON.parse(r.attendee_names || '[]').join('; '); } catch { return r.attendee_names; }
      }},
      { label: 'Created At',      value: (r) => r.created_at?.toISOString() },
    ];

    const csv = buildCsv(bookings, columns);
    const slug = event.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `event_${slug}_revenue_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary, getEventRevenue, getPaymentSessions, exportRevenue, exportEventRevenue };
