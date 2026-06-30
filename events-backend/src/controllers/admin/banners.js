const { v4: uuidv4 } = require('uuid');
const prisma = require('../../db');

async function getOrganizerEventIds(organizerId) {
  const events = await prisma.events.findMany({
    where: { organizer_id: organizerId },
    select: { id: true },
  });
  return events.map((e) => e.id);
}

async function assertBannerOwnership(bannerId, organizerId) {
  const banner = await prisma.event_banners.findUnique({ where: { id: bannerId } });
  if (!banner) return { error: 'Banner not found', status: 404 };
  const eventIds = await getOrganizerEventIds(organizerId);
  if (!eventIds.includes(banner.link_id)) {
    return { error: 'Forbidden: this banner does not belong to your events', status: 403 };
  }
  return { banner };
}

async function listBanners(req, res, next) {
  try {
    let banners;

    if (req.user.role === 'organizer') {
      const eventIds = await getOrganizerEventIds(req.user.organizer_id);
      banners = await prisma.event_banners.findMany({
        where: { link_type: 'event', link_id: { in: eventIds } },
        orderBy: { sort_order: 'asc' },
      });
    } else {
      banners = await prisma.event_banners.findMany({ orderBy: { sort_order: 'asc' } });
    }

    res.json({ success: true, data: banners });
  } catch (err) {
    next(err);
  }
}

async function createBanner(req, res, next) {
  try {
    const { title, subtitle, image_url, link_type = 'event', link_id, link_url, sort_order = 0, is_active = true } = req.body;

    if (!title || !image_url) {
      return res.status(400).json({ success: false, message: 'title and image_url are required' });
    }

    // Organizers can only create banners linked to their own events
    if (req.user.role === 'organizer') {
      if (!link_id) return res.status(400).json({ success: false, message: 'link_id (event ID) is required for organizers' });
      const eventIds = await getOrganizerEventIds(req.user.organizer_id);
      if (!eventIds.includes(link_id)) {
        return res.status(403).json({ success: false, message: 'Forbidden: you can only create banners for your own events' });
      }
    }

    const banner = await prisma.event_banners.create({
      data: {
        id: uuidv4(),
        title,
        subtitle: subtitle || null,
        image_url,
        link_type,
        link_id: link_id || null,
        link_url: link_url || null,
        sort_order: Number(sort_order),
        is_active: Boolean(is_active),
      },
    });

    res.status(201).json({ success: true, data: banner });
  } catch (err) {
    next(err);
  }
}

async function updateBanner(req, res, next) {
  try {
    const { id } = req.params;

    if (req.user.role === 'organizer') {
      const { error, status } = await assertBannerOwnership(id, req.user.organizer_id);
      if (error) return res.status(status).json({ success: false, message: error });
    } else {
      const banner = await prisma.event_banners.findUnique({ where: { id } });
      if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
    }

    const { title, subtitle, image_url, link_type, link_id, link_url, sort_order, is_active } = req.body;

    const updated = await prisma.event_banners.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(subtitle !== undefined && { subtitle }),
        ...(image_url !== undefined && { image_url }),
        ...(link_type !== undefined && { link_type }),
        ...(link_id !== undefined && { link_id }),
        ...(link_url !== undefined && { link_url }),
        ...(sort_order !== undefined && { sort_order: Number(sort_order) }),
        ...(is_active !== undefined && { is_active: Boolean(is_active) }),
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

async function deleteBanner(req, res, next) {
  try {
    const { id } = req.params;

    if (req.user.role === 'organizer') {
      const { error, status } = await assertBannerOwnership(id, req.user.organizer_id);
      if (error) return res.status(status).json({ success: false, message: error });
    } else {
      const banner = await prisma.event_banners.findUnique({ where: { id } });
      if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
    }

    await prisma.event_banners.delete({ where: { id } });
    res.json({ success: true, message: 'Banner deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listBanners, createBanner, updateBanner, deleteBanner };
