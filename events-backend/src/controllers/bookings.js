const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const walletApi = require('../services/walletApi');

function generateBookingId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `BK-${today}-${rand}`;
}

function generateTicketId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `TK-${today}-${rand}`;
}

function generateTicketCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `TD-${rand(2)}${rand(4)}${rand(2)}`;
}

const TX_OPTIONS = { timeout: 30000 };
const CATEGORY_TO_TIER = { regular: 'Regular', premium: 'VIP', balcony: 'Balcony' };
const TABDEY_WALLET_ID = process.env.TABDEY_WALLET_ID || 'TD00000001';
const DEFAULT_ORG_SHARE = 80;

// Charges the user once for the full amount (paid to the organizer), then
// settles the platform's share out of the organizer's wallet. This keeps the
// user's wallet history to a single debit per booking.
async function processWalletPayment(userId, organizerId, totalAmount, eventTitle, tPin) {
  // Fetch user wallet, organizer wallet, and share config in parallel
  const organizer = await prisma.event_organizers.findUnique({
    where: { id: organizerId },
    select: { user_id: true },
  });
  if (!organizer?.user_id) throw Object.assign(new Error('Organizer has no linked user account'), { status: 503 });

  const [userWalletData, orgWalletData, shareConfig] = await Promise.all([
    walletApi.getWalletByUser(userId.toString()),
    walletApi.getWalletByUser(organizer.user_id.toString()),
    prisma.organizer_revenue_share.findUnique({ where: { organizer_id: organizerId } }),
  ]);

  const userWalletId = userWalletData.data.wallet_id;
  const organizerWalletId = orgWalletData.data.wallet_id;

  const orgPct = shareConfig ? Number(shareConfig.org_share_pct) : DEFAULT_ORG_SHARE;
  const tabdeyPct = parseFloat((100 - orgPct).toFixed(2));
  const orgAmount = parseFloat((totalAmount * orgPct / 100).toFixed(2));
  const tabdeyAmount = parseFloat((totalAmount - orgAmount).toFixed(2));

  const orgReceipt = await walletApi.transfer({
    senderWalletId: userWalletId,
    recipientWalletId: organizerWalletId,
    amount: totalAmount,
    note: `${eventTitle} — ticket payment`,
    tPin,
  });
  const orgJournalCode = orgReceipt.receipt.journal_no;

  // Settle the platform's share from the organizer's wallet. If this fails,
  // the user's payment still stands — flag for manual reconciliation rather
  // than blocking the booking.
  let tabdeyJournalCode = null;
  if (tabdeyAmount > 0) {
    try {
      const tabdeyReceipt = await walletApi.transfer({
        senderWalletId: organizerWalletId,
        recipientWalletId: TABDEY_WALLET_ID,
        amount: tabdeyAmount,
        note: `${eventTitle} — platform share (${tabdeyPct}%)`,
      });
      tabdeyJournalCode = tabdeyReceipt.receipt.journal_no;
    } catch (settleErr) {
      console.error(
        `Platform settlement failed for journal ${orgJournalCode} (organizer ${organizerId}, amount ${tabdeyAmount}):`,
        settleErr,
      );
    }
  }

  return { orgJournalCode, tabdeyJournalCode, orgAmount, tabdeyAmount, orgPct, tabdeyPct, organizerId };
}

async function createBooking(req, res, next) {
  try {
    const { event_id, tier_id, quantity, attendee_names, payment_method, seat_ids, screening_id, t_pin } = req.body;
    const userId = BigInt(req.user.id);

    if (!payment_method) {
      return res.status(400).json({ success: false, message: 'payment_method is required' });
    }

    // ── Cinema booking (screening + seat map) ────────────────────────────────
    if (seat_ids?.length && screening_id) {
      // 1. Fetch screening
      const screening = await prisma.event_screenings.findUnique({
        where: { id: screening_id },
        select: { id: true, event_id: true, hall_id: true, show_date: true, show_time: true, status: true },
      });
      if (!screening) return res.status(404).json({ success: false, message: 'Screening not found' });
      if (screening.status === 'cancelled') return res.status(409).json({ success: false, message: 'This screening has been cancelled' });

      const resolvedEventId = screening.event_id;

      // 2. Fetch seat details, tiers, and event in parallel
      const [event_seats, tiers, event] = await Promise.all([
        prisma.event_seats.findMany({
          where: { id: { in: seat_ids } },
          select: { id: true, row_label: true, seat_number: true, category: true, section: true },
        }),
        prisma.event_ticket_tiers.findMany({ where: { event_id: resolvedEventId } }),
        prisma.events.findUnique({
          where: { id: resolvedEventId },
          select: { title: true, venue_name: true, organizer_id: true },
        }),
      ]);

      const tierByName = new Map(tiers.map((t) => [t.name.toLowerCase(), t]));
      let totalAmount = 0;
      const seatDetails = event_seats.map((seat) => {
        const tierName = CATEGORY_TO_TIER[seat.category] || 'Regular';
        const tier = tierByName.get(tierName.toLowerCase()) || tiers[0];
        totalAmount += tier.price;
        return { ...seat, tier_id: tier.id, tier_name: tier.name, price: tier.price };
      });
      const primaryTier = seatDetails[0];

      // 3. Process wallet payment (before DB write — split between organizer + tabdey)
      let payResult = null;
      if (payment_method === 'WALLET') {
        payResult = await processWalletPayment(
          userId, event.organizer_id, totalAmount,
          `Event booking: ${event.title} — ${seat_ids.length} seat(s)`,
          t_pin,
        );
      }

      // 4. Atomic DB writes — re-validates race-condition-sensitive state
      let result;
      try {
        result = await prisma.$transaction(async (tx) => {
          // Re-validate holds
          const holds = await tx.event_seat_holds.findMany({
            where: { screening_id, seat_id: { in: seat_ids }, user_id: userId, expires_at: { gt: new Date() } },
          });
          if (holds.length !== seat_ids.length) {
            throw Object.assign(
              new Error('Seat hold expired or not found. Please select your seats again.'),
              { status: 409 },
            );
          }

          // Re-check none just got confirmed by another request
          const alreadyBooked = await tx.event_booking_seats.findMany({
            where: { screening_id, seat_id: { in: seat_ids } },
            include: { event_bookings: { select: { status: true } } },
          });
          if (alreadyBooked.some((b) => b.event_bookings.status === 'confirmed')) {
            throw Object.assign(
              new Error('One or more seats were just booked by someone else.'),
              { status: 409 },
            );
          }

          const bookingId = generateBookingId();
          const ticketCode = generateTicketCode();
          const ticketId = generateTicketId();

          await tx.event_bookings.create({
            data: {
              id: bookingId,
              ticket_code: ticketCode,
              user_id: userId,
              event_id: resolvedEventId,
              screening_id,
              tier_id: primaryTier.tier_id,
              quantity: seat_ids.length,
              total_amount: totalAmount,
              payment_method,
              attendee_names: JSON.stringify(attendee_names || []),
              status: 'confirmed',
              payment_status: payment_method === 'WALLET' ? 'paid' : 'pending',
              wallet_journal_code: payResult?.orgJournalCode ?? null,
            },
          });

          await tx.event_booking_seats.createMany({
            data: seat_ids.map((seat_id) => ({
              booking_id: bookingId,
              seat_id,
              event_id: resolvedEventId,
              screening_id,
            })),
          });

          const tierDecrements = seatDetails.reduce((acc, s) => {
            acc[s.tier_id] = (acc[s.tier_id] || 0) + 1;
            return acc;
          }, {});
          await Promise.all(
            Object.entries(tierDecrements).map(([tid, count]) =>
              tx.event_ticket_tiers.update({ where: { id: tid }, data: { available_seats: { decrement: count } } }),
            ),
          );

          await tx.event_seat_holds.deleteMany({ where: { screening_id, user_id: userId } });

          // Update running revenue totals
          if (payResult) {
            await tx.organizer_revenue_share.upsert({
              where: { organizer_id: event.organizer_id },
              create: {
                organizer_id: event.organizer_id,
                org_share_pct: payResult.orgPct,
                tabdey_share_pct: payResult.tabdeyPct,
                total_revenue: totalAmount,
                total_org_revenue: payResult.orgAmount,
                total_tabdey_revenue: payResult.tabdeyAmount,
              },
              update: {
                total_revenue: { increment: totalAmount },
                total_org_revenue: { increment: payResult.orgAmount },
                total_tabdey_revenue: { increment: payResult.tabdeyAmount },
              },
            });
          }

          return {
            booking_id: bookingId,
            ticket_id: ticketId,
            ticket_code: ticketCode,
            event_id: resolvedEventId,
            screening_id,
            screening_date: screening.show_date.toISOString().slice(0, 10),
            screening_time: screening.show_time.toISOString().slice(11, 16),
            event_title: event.title,
            quantity: seat_ids.length,
            total_amount: totalAmount,
            payment_method,
            wallet_journal_code: payResult?.orgJournalCode ?? null,
            attendee_names: attendee_names || [],
            venue_name: event.venue_name,
            event_seats: seatDetails.map((s) => ({
              seat_id: s.id,
              row: s.row_label,
              number: s.seat_number,
              section: s.section,
              category: s.category,
              tier_name: s.tier_name,
              price: s.price,
            })),
            created_at: new Date().toISOString(),
          };
        }, TX_OPTIONS);
      } catch (txErr) {
        if (payResult) {
          txErr.message += ` Wallet journals: org=${payResult.orgJournalCode}, tabdey=${payResult.tabdeyJournalCode}. Please contact support.`;
        }
        throw txErr;
      }

      return res.status(201).json({ success: true, data: result });
    }

    // ── General admission (tier-based) ──────────────────────────────────────
    if (!tier_id || !quantity) {
      return res.status(400).json({ success: false, message: 'tier_id and quantity are required for general admission events' });
    }

    const [tier, event] = await Promise.all([
      prisma.event_ticket_tiers.findUnique({ where: { id: tier_id } }),
      prisma.events.findUnique({
        where: { id: event_id },
        select: { title: true, venue_name: true, start_at: true, organizer_id: true },
      }),
    ]);

    if (!tier || tier.event_id !== event_id) return res.status(404).json({ success: false, message: 'Tier not found' });
    if (!event) return res.status(404).json({ success: false, message: 'Event not found' });
    if (tier.available_seats < quantity) return res.status(409).json({ success: false, message: 'Not enough seats available' });

    const totalAmount = tier.price * quantity;

    let payResult = null;
    if (payment_method === 'WALLET') {
      payResult = await processWalletPayment(
        userId, event.organizer_id, totalAmount,
        `Event booking: ${event.title} — ${quantity} ticket(s)`,
        t_pin,
      );
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Re-check availability (race condition guard)
        const freshTier = await tx.event_ticket_tiers.findUnique({ where: { id: tier_id } });
        if (freshTier.available_seats < quantity) {
          throw Object.assign(new Error('Not enough seats available'), { status: 409 });
        }

        await tx.event_ticket_tiers.update({ where: { id: tier_id }, data: { available_seats: { decrement: quantity } } });

        const bookingId = generateBookingId();
        const ticketId = generateTicketId();
        const ticketCode = generateTicketCode();

        await tx.event_bookings.create({
          data: {
            id: bookingId,
            ticket_code: ticketCode,
            user_id: userId,
            event_id,
            tier_id,
            quantity,
            total_amount: totalAmount,
            payment_method,
            attendee_names: JSON.stringify(attendee_names || []),
            status: 'confirmed',
            payment_status: payment_method === 'WALLET' ? 'paid' : 'pending',
            wallet_journal_code: payResult?.orgJournalCode ?? null,
          },
        });

        // Update running revenue totals
        if (payResult) {
          await tx.organizer_revenue_share.upsert({
            where: { organizer_id: event.organizer_id },
            create: {
              organizer_id: event.organizer_id,
              org_share_pct: payResult.orgPct,
              tabdey_share_pct: payResult.tabdeyPct,
              total_revenue: totalAmount,
              total_org_revenue: payResult.orgAmount,
              total_tabdey_revenue: payResult.tabdeyAmount,
            },
            update: {
              total_revenue: { increment: totalAmount },
              total_org_revenue: { increment: payResult.orgAmount },
              total_tabdey_revenue: { increment: payResult.tabdeyAmount },
            },
          });
        }

        return {
          booking_id: bookingId,
          ticket_id: ticketId,
          ticket_code: ticketCode,
          event_id,
          event_title: event.title,
          tier_id,
          tier_name: tier.name,
          quantity,
          total_amount: totalAmount,
          payment_method,
          wallet_journal_code: payResult?.orgJournalCode ?? null,
          attendee_names: attendee_names || [],
          event_start_at: event.start_at,
          venue_name: event.venue_name,
          created_at: new Date().toISOString(),
        };
      }, TX_OPTIONS);
    } catch (txErr) {
      if (payResult) {
        txErr.message += ` Wallet journals: org=${payResult.orgJournalCode}, tabdey=${payResult.tabdeyJournalCode}. Please contact support.`;
      }
      throw txErr;
    }

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function myTickets(req, res, next) {
  try {
    const userId = BigInt(req.user.id);

    const rows = await prisma.$queryRaw`
      SELECT
        b.id, b.ticket_code, b.event_id, b.tier_id, b.quantity,
        b.total_amount, b.payment_method, b.attendee_names,
        b.status, b.created_at, b.screening_id,
        e.title  AS event_title,
        e.venue_name,
        e.start_at AS event_start_at,
        t.name   AS tier_name
      FROM event_bookings b
      JOIN events               e ON e.id = b.event_id
      JOIN event_ticket_tiers   t ON t.id = b.tier_id
      WHERE b.user_id = ${userId}
      ORDER BY b.created_at DESC
    `;

    const bookingIds = rows.map((r) => r.id);

    let seatsByBooking = {};
    if (bookingIds.length > 0) {
      const seats = await prisma.$queryRaw`
        SELECT
          bs.booking_id, bs.seat_id,
          s.row_label, s.seat_number, s.section, s.category
        FROM event_booking_seats bs
        JOIN event_seats s ON s.id = bs.seat_id
        WHERE bs.booking_id IN (${Prisma.join(bookingIds)})
      `;
      seats.forEach((s) => {
        if (!seatsByBooking[s.booking_id]) seatsByBooking[s.booking_id] = [];
        seatsByBooking[s.booking_id].push({
          seat_id:  s.seat_id,
          row:      s.row_label,
          number:   s.seat_number,
          section:  s.section,
          category: s.category,
        });
      });
    }

    const data = rows.map((b) => ({
      id:             b.id,
      ticket_code:    b.ticket_code,
      event_id:       b.event_id,
      event_title:    b.event_title,
      tier_id:        b.tier_id,
      tier_name:      b.tier_name,
      quantity:       Number(b.quantity),
      total_amount:   Number(b.total_amount),
      payment_method: b.payment_method,
      attendee_names: typeof b.attendee_names === 'string' ? JSON.parse(b.attendee_names) : (b.attendee_names ?? []),
      event_start_at: b.event_start_at,
      venue_name:     b.venue_name,
      created_at:     b.created_at,
      status:         b.status,
      event_seats:    seatsByBooking[b.id] ?? [],
    }));

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function deleteBooking(req, res, next) {
  try {
    const { bookingId } = req.params;
    const userId = BigInt(req.user.id);

    const booking = await prisma.event_bookings.findUnique({ where: { id: bookingId } });

    if (!booking || booking.user_id !== userId) {
      const err = new Error('Booking not found'); err.status = 404; throw err;
    }

    await prisma.event_bookings.delete({ where: { id: bookingId } });

    res.json({ success: true, message: 'Booking deleted.' });
  } catch (err) {
    next(err);
  }
}

async function verifyTicket(req, res, next) {
  try {
    const { ticket_code } = req.body;
    if (!ticket_code) {
      return res.status(400).json({ success: false, message: 'ticket_code is required' });
    }

    const booking = await prisma.event_bookings.findUnique({
      where: { ticket_code: ticket_code.trim() },
      include: {
        events: { select: { title: true, venue_name: true, start_at: true } },
        event_ticket_tiers: { select: { name: true } },
      },
    });

    if (!booking) {
      return res.json({ success: true, data: { found: false } });
    }

    const attendees = typeof booking.attendee_names === 'string'
      ? JSON.parse(booking.attendee_names)
      : (booking.attendee_names || []);

    const base = {
      found: true,
      booking_id: booking.id,
      ticket_code: booking.ticket_code,
      status: booking.status,
      event_title: booking.events.title,
      venue_name: booking.events.venue_name,
      event_start_at: booking.events.start_at,
      tier_name: booking.event_ticket_tiers.name,
      quantity: booking.quantity,
      attendee_names: attendees,
      checked_in_at: booking.checked_in_at,
    };

    // Already used — return info without marking again
    if (booking.status === 'used') {
      return res.json({ success: true, data: { ...base, status: 'used' } });
    }

    // Cancelled — do not allow entry
    if (booking.status === 'cancelled') {
      return res.json({ success: true, data: { ...base, status: 'cancelled' } });
    }

    // Valid — mark as used (checked_in_at not yet in generated client, use raw)
    const now = new Date();
    await prisma.$executeRawUnsafe(
      `UPDATE event_bookings SET status = 'used', checked_in_at = ? WHERE ticket_code = ?`,
      now,
      ticket_code.trim(),
    );

    return res.json({ success: true, data: { ...base, status: 'confirmed', checked_in_at: now } });
  } catch (err) {
    next(err);
  }
}

module.exports = { createBooking, myTickets, deleteBooking, verifyTicket };
