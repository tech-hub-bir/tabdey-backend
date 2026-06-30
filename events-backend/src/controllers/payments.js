const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');
const bfs = require('../services/bfs');

// ─── Step 1: Init bank payment ────────────────────────────────────────────────
// Stores booking context, calls BFS init, returns orderNo + bank list
// POST /events/api/payments/bank/init
async function initBankPayment(req, res, next) {
  try {
    const userId = BigInt(req.user.id);
    const { booking_context, email } = req.body;
    // booking_context = { type, event_id, screening_id, seat_ids, tier_id, quantity, attendee_names }

    if (!booking_context || !email) {
      return res.status(400).json({ success: false, message: 'booking_context and email are required' });
    }

    // Compute amount from context
    let totalAmount = 0;
    if (booking_context.type === 'cinema' && booking_context.seat_ids?.length) {
      const seats = await prisma.event_seats.findMany({
        where: { id: { in: booking_context.seat_ids } },
        select: { category: true },
      });
      const tiers = await prisma.event_ticket_tiers.findMany({
        where: { event_id: booking_context.event_id },
      });
      const CATEGORY_TO_TIER = { regular: 'regular', premium: 'vip', balcony: 'balcony' };
      const tierByName = new Map(tiers.map(t => [t.name.toLowerCase(), t]));
      seats.forEach(seat => {
        const tierName = CATEGORY_TO_TIER[seat.category] || 'regular';
        const tier = tierByName.get(tierName) || tiers[0];
        totalAmount += tier.price;
      });
    } else if (booking_context.tier_id && booking_context.quantity) {
      const tier = await prisma.event_ticket_tiers.findUnique({ where: { id: booking_context.tier_id } });
      if (!tier) return res.status(404).json({ success: false, message: 'Tier not found' });
      totalAmount = tier.price * booking_context.quantity;
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Could not compute payment amount' });
    }

    // Extract token for BFS service-to-service auth
    const token = req.headers.authorization?.slice(7);

    // Call BFS to init payment
    const bfsData = await bfs.initPayment({
      userId: Number(userId),
      amount: totalAmount,
      email,
      description: `Event ticket BTN ${totalAmount}`,
    }, token);

    // Store payment session
    await prisma.event_payment_sessions.create({
      data: {
        id: uuidv4(),
        user_id: userId,
        order_no: bfsData.orderNo,
        bfs_txn_id: bfsData.bfsTxnId,
        amount: totalAmount,
        payment_context: booking_context,
        status: 'pending',
      },
    });

    res.json({
      success: true,
      data: {
        order_no: bfsData.orderNo,
        amount: totalAmount,
        bank_list: bfsData.bankList,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Step 2: Account enquiry ──────────────────────────────────────────────────
// POST /events/api/payments/bank/account-enquiry
async function accountEnquiry(req, res, next) {
  try {
    const { order_no, bank_id, account_no } = req.body;

    if (!order_no || !bank_id || !account_no) {
      return res.status(400).json({ success: false, message: 'order_no, bank_id, and account_no are required' });
    }

    const session = await prisma.event_payment_sessions.findUnique({ where: { order_no } });
    if (!session || session.status !== 'pending') {
      return res.status(404).json({ success: false, message: 'Payment session not found or already completed' });
    }

    const result = await bfs.accountEnquiry({
      orderNo: order_no,
      remitterBankId: bank_id,
      remitterAccNo: account_no,
    });

    res.json({
      success: true,
      data: {
        order_no: result.orderNo,
        status: result.status,
        message: result.responseDesc,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Step 3: Verify OTP and confirm booking ───────────────────────────────────
// POST /events/api/payments/bank/verify
async function verifyOtp(req, res, next) {
  try {
    const userId = BigInt(req.user.id);
    const { order_no, otp } = req.body;

    if (!order_no || !otp) {
      return res.status(400).json({ success: false, message: 'order_no and otp are required' });
    }

    const session = await prisma.event_payment_sessions.findUnique({ where: { order_no } });
    if (!session || session.status !== 'pending') {
      return res.status(404).json({ success: false, message: 'Payment session not found or already completed' });
    }
    if (session.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Call BFS debit
    const bfsResult = await bfs.debitWithOtp({ orderNo: order_no, otp });

    if (bfsResult.status !== 'SUCCESS') {
      await prisma.event_payment_sessions.update({
        where: { order_no },
        data: { status: 'failed' },
      });
      return res.status(402).json({
        success: false,
        message: bfsResult.message || 'Payment failed',
        code: bfsResult.code,
      });
    }

    // Payment succeeded — confirm the booking
    const ctx = session.payment_context;
    const bookingResult = await confirmBookingFromSession(tx => tx, userId, ctx, session.amount, 'BANK', order_no);

    // Mark session as success
    await prisma.event_payment_sessions.update({
      where: { order_no },
      data: { status: 'success', bfs_txn_id: bfsResult.bfsTxnId || session.bfs_txn_id },
    });

    res.json({ success: true, data: bookingResult });
  } catch (err) {
    next(err);
  }
}

// ─── Step 4: Check payment status ────────────────────────────────────────────
// GET /events/api/payments/bank/status/:orderNo
async function checkStatus(req, res, next) {
  try {
    const { orderNo } = req.params;

    const [session, bfsStatus] = await Promise.all([
      prisma.event_payment_sessions.findUnique({
        where: { order_no: orderNo },
        select: { status: true, amount: true, created_at: true },
      }),
      bfs.getStatus(orderNo),
    ]);

    res.json({
      success: true,
      data: {
        order_no: orderNo,
        session_status: session?.status,
        bfs_status: bfsStatus.status,
        bfs_code: bfsStatus.code,
        amount: session?.amount,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Internal: compute revenue split amounts from share config ────────────────
async function getRevenueSplit(tx, organizerId, totalAmount) {
  const shareConfig = await tx.organizer_revenue_share.findUnique({
    where: { organizer_id: organizerId },
  });
  const orgPct     = shareConfig ? Number(shareConfig.org_share_pct) : 80;
  const tabdeyPct  = parseFloat((100 - orgPct).toFixed(2));
  const orgAmount  = parseFloat((totalAmount * orgPct / 100).toFixed(2));
  const tabdeyAmount = parseFloat((totalAmount - orgAmount).toFixed(2));
  return { orgPct, tabdeyPct, orgAmount, tabdeyAmount };
}

// ─── Internal: upsert organizer_revenue_share running totals ─────────────────
async function trackRevenueShare(tx, organizerId, totalAmount, split) {
  await tx.organizer_revenue_share.upsert({
    where: { organizer_id: organizerId },
    create: {
      organizer_id:        organizerId,
      org_share_pct:       split.orgPct,
      tabdey_share_pct:    split.tabdeyPct,
      total_revenue:       totalAmount,
      total_org_revenue:   split.orgAmount,
      total_tabdey_revenue: split.tabdeyAmount,
    },
    update: {
      total_revenue:        { increment: totalAmount },
      total_org_revenue:    { increment: split.orgAmount },
      total_tabdey_revenue: { increment: split.tabdeyAmount },
    },
  });
}

// ─── Internal: create confirmed booking after BFS payment ────────────────────
async function confirmBookingFromSession(_, userId, ctx, totalAmount, paymentMethod, orderNo) {
  function genBookingId() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `BK-${today}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
  }
  function genTicketCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const r = n => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `TD-${r(2)}${r(4)}${r(2)}`;
  }

  return prisma.$transaction(async (tx) => {
    const bookingId  = genBookingId();
    const ticketCode = genTicketCode();

    if (ctx.type === 'cinema' && ctx.seat_ids?.length) {
      // Cinema booking
      const tiers = await tx.event_ticket_tiers.findMany({ where: { event_id: ctx.event_id } });
      const seats = await tx.event_seats.findMany({ where: { id: { in: ctx.seat_ids } } });
      const CATEGORY_TO_TIER = { regular: 'regular', premium: 'vip', balcony: 'balcony' };
      const tierByName  = new Map(tiers.map(t => [t.name.toLowerCase(), t]));
      const primaryTier = tierByName.get(CATEGORY_TO_TIER[seats[0]?.category] || 'regular') || tiers[0];
      const event = await tx.events.findUnique({
        where: { id: ctx.event_id },
        select: { title: true, venue_name: true, organizer_id: true },
      });

      await tx.event_bookings.create({
        data: {
          id: bookingId, ticket_code: ticketCode,
          user_id: userId, event_id: ctx.event_id, screening_id: ctx.screening_id,
          tier_id: primaryTier.id, quantity: ctx.seat_ids.length,
          total_amount: totalAmount, payment_method: paymentMethod,
          attendee_names: JSON.stringify(ctx.attendee_names || []),
          status: 'confirmed', payment_status: 'paid',
          wallet_journal_code: orderNo,
        },
      });

      await tx.event_booking_seats.createMany({
        data: ctx.seat_ids.map(seat_id => ({
          booking_id: bookingId, seat_id, event_id: ctx.event_id, screening_id: ctx.screening_id,
        })),
      });

      const seatTierIds = seats.map(s => (tierByName.get(CATEGORY_TO_TIER[s.category] || 'regular') || tiers[0]).id);
      const tierDecrements = seatTierIds.reduce((acc, id) => { acc[id] = (acc[id] || 0) + 1; return acc; }, {});
      await Promise.all(Object.entries(tierDecrements).map(([id, count]) =>
        tx.event_ticket_tiers.update({ where: { id }, data: { available_seats: { decrement: count } } })
      ));

      await tx.event_seat_holds.deleteMany({ where: { screening_id: ctx.screening_id, user_id: userId } });

      // Track revenue split (no wallet transfer for bank — amounts recorded for admin payout)
      if (event.organizer_id) {
        const split = await getRevenueSplit(tx, event.organizer_id, totalAmount);
        await trackRevenueShare(tx, event.organizer_id, totalAmount, split);
      }

      return { booking_id: bookingId, ticket_code: ticketCode, event_title: event.title, total_amount: totalAmount, seats: ctx.seat_ids };
    } else {
      // General admission
      const tier  = await tx.event_ticket_tiers.findUnique({ where: { id: ctx.tier_id } });
      const event = await tx.events.findUnique({
        where: { id: ctx.event_id },
        select: { title: true, venue_name: true, start_at: true, organizer_id: true },
      });

      await tx.event_ticket_tiers.update({ where: { id: ctx.tier_id }, data: { available_seats: { decrement: ctx.quantity } } });

      await tx.event_bookings.create({
        data: {
          id: bookingId, ticket_code: ticketCode,
          user_id: userId, event_id: ctx.event_id,
          tier_id: ctx.tier_id, quantity: ctx.quantity,
          total_amount: totalAmount, payment_method: paymentMethod,
          attendee_names: JSON.stringify(ctx.attendee_names || []),
          status: 'confirmed', payment_status: 'paid',
          wallet_journal_code: orderNo,
        },
      });

      // Track revenue split (no wallet transfer for bank — amounts recorded for admin payout)
      if (event.organizer_id) {
        const split = await getRevenueSplit(tx, event.organizer_id, totalAmount);
        await trackRevenueShare(tx, event.organizer_id, totalAmount, split);
      }

      return { booking_id: bookingId, ticket_code: ticketCode, event_title: event.title, tier_name: tier.name, quantity: ctx.quantity, total_amount: totalAmount };
    }
  }, { timeout: 30000 });
}

module.exports = { initBankPayment, accountEnquiry, verifyOtp, checkStatus };
