const { v4: uuidv4 } = require('uuid');
const prisma = require('../../db');

async function createScreening(req, res, next) {
  try {
    const { eventId } = req.params;
    const { hall_id, show_date, show_time } = req.body;

    if (!hall_id || !show_date || !show_time) {
      return res.status(400).json({ success: false, message: 'hall_id, show_date, and show_time are required' });
    }

    const [event, hall] = await Promise.all([
      prisma.events.findUnique({ where: { id: eventId }, select: { id: true } }),
      prisma.event_halls.findUnique({ where: { id: hall_id }, select: { id: true, name: true } }),
    ]);

    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    if (!hall) return res.status(404).json({ success: false, message: 'Hall not found' });

    const screening = await prisma.event_screenings.create({
      data: {
        id: uuidv4(),
        event_id: eventId,
        hall_id,
        show_date: new Date(show_date),
        show_time: new Date(`1970-01-01T${show_time}:00Z`),
        status: 'active',
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: screening.id,
        event_id: screening.event_id,
        hall_id: screening.hall_id,
        hall_name: hall.name,
        show_date: screening.show_date.toISOString().slice(0, 10),
        show_time: screening.show_time.toISOString().slice(11, 16),
        status: screening.status,
        created_at: screening.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function cancelScreening(req, res, next) {
  try {
    const { id } = req.params;

    const screening = await prisma.event_screenings.findUnique({ where: { id } });
    if (!screening) return res.status(404).json({ success: false, message: 'Screening not found' });
    if (screening.status === 'cancelled') {
      return res.status(409).json({ success: false, message: 'Screening is already cancelled' });
    }

    await prisma.event_screenings.update({ where: { id }, data: { status: 'cancelled' } });
    res.json({ success: true, message: 'Screening cancelled.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { createScreening, cancelScreening };
