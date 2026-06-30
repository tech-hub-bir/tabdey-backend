const prisma = require('../db');

async function toggle(req, res, next) {
  try {
    const { event_id } = req.body;
    const userId = BigInt(req.user.id);

    if (!event_id) {
      return res.status(400).json({ success: false, message: 'event_id is required' });
    }

    const existing = await prisma.event_wishlists.findUnique({
      where: { user_id_event_id: { user_id: userId, event_id } },
    });

    if (existing) {
      await prisma.event_wishlists.delete({
        where: { user_id_event_id: { user_id: userId, event_id } },
      });
      return res.json({ success: true, saved: false });
    }

    await prisma.event_wishlists.create({ data: { user_id: userId, event_id } });
    res.json({ success: true, saved: true });
  } catch (err) {
    next(err);
  }
}

async function getWishlist(req, res, next) {
  try {
    const userId = BigInt(req.user.id);

    const items = await prisma.event_wishlists.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      select: { event_id: true },
    });

    res.json({ success: true, data: items.map((i) => i.event_id) });
  } catch (err) {
    next(err);
  }
}

module.exports = { toggle, getWishlist };
