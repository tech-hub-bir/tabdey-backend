const { v4: uuidv4 } = require('uuid');
const prisma = require('../../db');

async function createTier(req, res, next) {
  try {
    const { eventId } = req.params;
    const { name, description, price, available_seats } = req.body;

    if (!name || price === undefined || available_seats === undefined) {
      return res.status(400).json({ success: false, message: 'name, price, and available_seats are required' });
    }

    const event = await prisma.events.findUnique({ where: { id: eventId }, select: { id: true } });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });

    const tier = await prisma.event_ticket_tiers.create({
      data: {
        id: uuidv4(),
        event_id: eventId,
        name,
        description: description || null,
        price: Number(price),
        available_seats: Number(available_seats),
      },
    });

    res.status(201).json({ success: true, data: tier });
  } catch (err) {
    next(err);
  }
}

async function updateTier(req, res, next) {
  try {
    const { tierId } = req.params;
    const { name, description, price, available_seats } = req.body;

    const tier = await prisma.event_ticket_tiers.findUnique({ where: { id: tierId } });
    if (!tier) return res.status(404).json({ success: false, message: 'Tier not found' });

    const updated = await prisma.event_ticket_tiers.update({
      where: { id: tierId },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(price !== undefined && { price: Number(price) }),
        ...(available_seats !== undefined && { available_seats: Number(available_seats) }),
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

async function deleteTier(req, res, next) {
  try {
    const { tierId } = req.params;

    const tier = await prisma.event_ticket_tiers.findUnique({ where: { id: tierId } });
    if (!tier) return res.status(404).json({ success: false, message: 'Tier not found' });

    const bookingCount = await prisma.event_bookings.count({ where: { tier_id: tierId } });
    if (bookingCount > 0) {
      return res.status(409).json({
        success: false,
        message: `${bookingCount} booking(s) reference this tier. Cannot delete.`,
      });
    }

    await prisma.event_ticket_tiers.delete({ where: { id: tierId } });
    res.json({ success: true, message: 'Tier deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { createTier, updateTier, deleteTier };
