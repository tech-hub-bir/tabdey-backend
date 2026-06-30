const prisma = require('../db');

async function getBanners(req, res, next) {
  try {
    const banners = await prisma.event_banners.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' },
      select: {
        id: true,
        title: true,
        subtitle: true,
        image_url: true,
        link_type: true,
        link_id: true,
        link_url: true,
      },
    });

    res.json({ success: true, data: banners });
  } catch (err) {
    next(err);
  }
}

module.exports = { getBanners };
