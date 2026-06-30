const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const prisma = require('../../db');
const walletApi = require('../../services/walletApi');

const DEFAULT_PASSWORD = 'password123';

async function listOrganizers(req, res, next) {
  try {
    const organizers = await prisma.event_organizers.findMany({
      orderBy: { created_at: 'desc' },
      include: {
        _count: { select: { events: true } },
        users: {
          select: {
            user_id: true,
            user_name: true,
            email: true,
            phone: true,
            profile_image: true,
            is_verified: true,
            is_active: true,
            last_login: true,
          },
        },
      },
    });

    const userIds = organizers
      .filter((o) => o.users)
      .map((o) => o.users.user_id);

    const wallets = await prisma.wallets.findMany({
      where: { user_id: { in: userIds } },
      select: { user_id: true, wallet_id: true },
    });

    const walletMap = new Map(wallets.map((w) => [w.user_id.toString(), w.wallet_id]));

    res.json({
      success: true,
      data: organizers.map((o) => ({
        id: o.id,
        name: o.name,
        event_count: o._count.events,
        created_at: o.created_at,
        user: o.users
          ? {
              user_id: o.users.user_id.toString(),
              user_name: o.users.user_name,
              email: o.users.email,
              phone: o.users.phone,
              profile_image: o.users.profile_image,
              is_verified: o.users.is_verified,
              is_active: o.users.is_active,
              last_login: o.users.last_login,
              wallet_id: walletMap.get(o.users.user_id.toString()) ?? null,
            }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function createOrganizer(req, res, next) {
  try {
    if (req.user.role === 'organizer') {
      return res.status(403).json({ success: false, message: 'Forbidden: organizers cannot add other organizers' });
    }

    const { name, email, phone } = req.body;
    if (!name || !email || !phone) {
      return res.status(400).json({ success: false, message: 'name, email, and phone are required' });
    }

    const existing = await prisma.users.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A user with this email already exists' });
    }

    const password_hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

    // Create user first to get the auto-generated user_id, then link organizer to it
    const user = await prisma.users.create({
      data: { user_name: name, email, phone, password_hash, role: 'organizer', is_verified: true, is_active: true },
    });

    const organizer = await prisma.event_organizers.create({
      data: { id: uuidv4(), name, user_id: user.user_id },
    });

    // Auto-provision wallet — non-fatal if the wallet service is unavailable
    let wallet_id = null;
    try {
      const walletData = await walletApi.createWallet(user.user_id);
      wallet_id = walletData.data.wallet_id;
    } catch (walletErr) {
      console.error(`Wallet creation failed for user ${user.user_id}:`, walletErr.message);
    }

    res.status(201).json({
      success: true,
      data: { id: organizer.id, name: organizer.name, email, phone, default_password: DEFAULT_PASSWORD, wallet_id },
    });
  } catch (err) {
    next(err);
  }
}

async function getOrganizerRevenue(req, res, next) {
  try {
    const { id } = req.params;

    const organizer = await prisma.event_organizers.findUnique({ where: { id } });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });

    const events = await prisma.events.findMany({
      where: { organizer_id: id },
      select: { id: true, title: true, category: true, start_at: true },
    });

    const eventIds = events.map((e) => e.id);

    const [totals, byEvent] = await Promise.all([
      prisma.event_bookings.aggregate({
        where: { event_id: { in: eventIds }, status: 'confirmed' },
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.event_bookings.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds }, status: 'confirmed' },
        _sum: { total_amount: true, quantity: true },
        _count: { id: true },
      }),
    ]);

    const revenueMap = new Map(byEvent.map((b) => [b.event_id, b]));

    res.json({
      success: true,
      data: {
        organizer: { id: organizer.id, name: organizer.name },
        gross_revenue: totals._sum.total_amount || 0,
        tickets_sold: totals._sum.quantity || 0,
        total_bookings: totals._count.id,
        events: events.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category,
          start_at: e.start_at,
          revenue: revenueMap.get(e.id)?._sum.total_amount || 0,
          tickets_sold: revenueMap.get(e.id)?._sum.quantity || 0,
          booking_count: revenueMap.get(e.id)?._count.id || 0,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function deleteOrganizer(req, res, next) {
  try {
    if (req.user.role === 'organizer') {
      return res.status(403).json({ success: false, message: 'Forbidden: organizers cannot remove organizers' });
    }

    const { id } = req.params;

    const organizer = await prisma.event_organizers.findUnique({
      where: { id },
      include: { _count: { select: { events: true } } },
    });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });

    if (organizer._count.events > 0) {
      return res.status(409).json({
        success: false,
        message: `Cannot remove organizer — they have ${organizer._count.events} event(s). Delete or reassign those events first.`,
      });
    }

    const userId = organizer.user_id;
    await prisma.event_organizers.delete({ where: { id } });
    if (userId) await prisma.users.delete({ where: { user_id: userId } });

    res.json({ success: true, message: `Organizer "${organizer.name}" removed.` });
  } catch (err) {
    next(err);
  }
}

async function getOrganizerWallet(req, res, next) {
  try {
    const { id } = req.params;
    const organizer = await prisma.event_organizers.findUnique({
      where: { id },
      select: { name: true, user_id: true },
    });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });
    if (!organizer.user_id) return res.status(404).json({ success: false, message: 'Organizer has no linked user account' });

    const walletData = await walletApi.getWalletByUser(organizer.user_id.toString());
    res.json({
      success: true,
      data: {
        organizer: { id, name: organizer.name },
        wallet: walletData.data,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function getOrganizerWalletTransactions(req, res, next) {
  try {
    const { id } = req.params;
    const { limit, cursor, start, end, direction } = req.query;

    const organizer = await prisma.event_organizers.findUnique({
      where: { id },
      select: { user_id: true },
    });
    if (!organizer) return res.status(404).json({ success: false, message: 'Organizer not found' });
    if (!organizer.user_id) return res.status(404).json({ success: false, message: 'Organizer has no linked user account' });

    const data = await walletApi.getUserTransactions(organizer.user_id.toString(), { limit, cursor, start, end, direction });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

module.exports = { listOrganizers, createOrganizer, deleteOrganizer, getOrganizerRevenue, getOrganizerWallet, getOrganizerWalletTransactions };
