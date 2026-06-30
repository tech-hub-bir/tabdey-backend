const prisma = require('../../db');

function serializeShare(share) {
  if (!share) return null;
  return {
    ...share,
    updated_by: share.updated_by ? share.updated_by.toString() : null,
  };
}

async function getRevenueShare(req, res, next) {
  try {
    const { id } = req.params;

    const organizer = await prisma.event_organizers.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        organizer_revenue_share: true,
      },
    });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });

    res.json({
      success: true,
      data: {
        organizer: { id: organizer.id, name: organizer.name },
        share: serializeShare(organizer.organizer_revenue_share),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function upsertRevenueShare(req, res, next) {
  try {
    const { id } = req.params;
    const { org_share_pct } = req.body;

    const pct = parseFloat(org_share_pct);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ success: false, message: 'org_share_pct must be a number between 0 and 100' });
    }

    const tabdey_share_pct = parseFloat((100 - pct).toFixed(2));

    const organizer = await prisma.event_organizers.findUnique({ where: { id } });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });

    const share = await prisma.organizer_revenue_share.upsert({
      where: { organizer_id: id },
      create: {
        organizer_id: id,
        org_share_pct: pct,
        tabdey_share_pct,
        updated_by: BigInt(req.user.id),
      },
      update: {
        org_share_pct: pct,
        tabdey_share_pct,
        updated_by: BigInt(req.user.id),
      },
    });

    res.json({ success: true, data: serializeShare(share) });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRevenueShare, upsertRevenueShare };
