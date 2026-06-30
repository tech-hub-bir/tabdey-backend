const { v4: uuidv4 } = require('uuid');
const prisma = require('../../db');

function isOrganizer(req) { return req.user.role === 'organizer'; }

async function assertHallOwnership(hallId, organizerId) {
  const hall = await prisma.event_halls.findUnique({ where: { id: hallId }, select: { id: true, organizer_id: true } });
  if (!hall) return { error: 'Hall not found', status: 404 };
  if (hall.organizer_id !== organizerId) return { error: 'Forbidden: this hall does not belong to you', status: 403 };
  return { hall };
}

async function listHalls(req, res, next) {
  try {
    const where = isOrganizer(req) ? { organizer_id: req.user.organizer_id } : {};

    const halls = await prisma.event_halls.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { event_seats: true } } },
    });

    res.json({
      success: true,
      data: halls.map((h) => ({
        id: h.id,
        venue_name: h.venue_name,
        name: h.name,
        total_seats: h.total_seats,
        has_balcony: h.has_balcony,
        seat_count: h._count.event_seats,
        created_at: h.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function createHall(req, res, next) {
  try {
    const { venue_name, name, total_seats, has_balcony = false } = req.body;

    if (!venue_name || !name || total_seats === undefined) {
      return res.status(400).json({ success: false, message: 'venue_name, name, and total_seats are required' });
    }

    const organizer_id = isOrganizer(req) ? req.user.organizer_id : (req.body.organizer_id || null);

    const hall = await prisma.event_halls.create({
      data: { id: uuidv4(), venue_name, name, total_seats: Number(total_seats), has_balcony: Boolean(has_balcony), organizer_id },
    });

    res.status(201).json({ success: true, data: hall });
  } catch (err) {
    next(err);
  }
}

async function createSeats(req, res, next) {
  try {
    const { id: hallId } = req.params;
    const { seats } = req.body;

    if (!Array.isArray(seats) || seats.length === 0) {
      return res.status(400).json({ success: false, message: 'seats must be a non-empty array' });
    }

    if (isOrganizer(req)) {
      const { error, status } = await assertHallOwnership(hallId, req.user.organizer_id);
      if (error) return res.status(status).json({ success: false, message: error });
    } else {
      const hall = await prisma.event_halls.findUnique({ where: { id: hallId }, select: { id: true } });
      if (!hall) return res.status(404).json({ success: false, message: 'Hall not found' });
    }

    await prisma.event_seats.createMany({
      data: seats.map((s) => ({
        id: uuidv4(),
        hall_id: hallId,
        row_label: s.row_label,
        seat_number: s.seat_number,
        column_position: s.column_position,
        section: s.section || 'main',
        category: s.category || 'regular',
      })),
      skipDuplicates: true,
    });

    const newCount = await prisma.event_seats.count({ where: { hall_id: hallId } });
    await prisma.event_halls.update({ where: { id: hallId }, data: { total_seats: newCount } });

    res.status(201).json({
      success: true,
      message: `${seats.length} seat(s) added. Hall total is now ${newCount}.`,
    });
  } catch (err) {
    next(err);
  }
}

async function listSeats(req, res, next) {
  try {
    const { id: hallId } = req.params;

    if (isOrganizer(req)) {
      const { error, status } = await assertHallOwnership(hallId, req.user.organizer_id);
      if (error) return res.status(status).json({ success: false, message: error });
    }

    const seats = await prisma.event_seats.findMany({
      where: { hall_id: hallId },
      orderBy: [{ row_label: 'asc' }, { seat_number: 'asc' }],
    });

    const byRow = {};
    for (const s of seats) {
      const key = `${s.row_label}__${s.section}`;
      if (!byRow[key]) byRow[key] = { row_label: s.row_label, section: s.section, category: s.category, seats: [] };
      byRow[key].seats.push(s.seat_number);
    }

    res.json({ success: true, data: Object.values(byRow) });
  } catch (err) {
    next(err);
  }
}

async function deleteRowSeats(req, res, next) {
  try {
    const { id: hallId } = req.params;
    const { row, section } = req.query;

    if (!row || !section) return res.status(400).json({ success: false, message: 'row and section query params are required' });

    if (isOrganizer(req)) {
      const { error, status } = await assertHallOwnership(hallId, req.user.organizer_id);
      if (error) return res.status(status).json({ success: false, message: error });
    }

    const { count } = await prisma.event_seats.deleteMany({
      where: { hall_id: hallId, row_label: row, section },
    });

    const newCount = await prisma.event_seats.count({ where: { hall_id: hallId } });
    await prisma.event_halls.update({ where: { id: hallId }, data: { total_seats: newCount } });

    res.json({ success: true, message: `${count} seat(s) in ${section} row ${row} deleted.` });
  } catch (err) {
    next(err);
  }
}

module.exports = { listHalls, createHall, createSeats, listSeats, deleteRowSeats };
