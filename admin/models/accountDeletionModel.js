const { prisma } = require("../lib/prisma.js");

async function getLatestByUser(user_id) {
  return prisma.account_deletion_requests.findFirst({
    where: { user_id: Number(user_id) },
    orderBy: { requested_at: "desc" },
    select: {
      request_id: true,
      status: true,
      requested_at: true,
      resolved_at: true,
      reject_note: true,
    },
  });
}

async function listRequests({ status, page, limit }) {
  const where = status && status !== "all" ? { status } : {};
  const skip = (page - 1) * limit;

  const [total, rows] = await Promise.all([
    prisma.account_deletion_requests.count({ where }),
    prisma.account_deletion_requests.findMany({
      where,
      skip,
      take: limit,
      orderBy: { requested_at: "desc" },
      select: {
        request_id: true,
        user_id: true,
        reason: true,
        status: true,
        requested_at: true,
        resolved_at: true,
        resolved_by: true,
        reject_note: true,
        users: {
          select: { user_name: true, email: true, phone: true },
        },
      },
    }),
  ]);

  return {
    total,
    data: rows.map((r) => ({
      request_id: Number(r.request_id),
      user_id: Number(r.user_id),
      user_name: r.users?.user_name ?? null,
      email: r.users?.email ?? null,
      phone: r.users?.phone ?? null,
      reason: r.reason,
      status: r.status,
      requested_at: r.requested_at,
      resolved_at: r.resolved_at,
      resolved_by: r.resolved_by ? Number(r.resolved_by) : null,
      reject_note: r.reject_note,
    })),
  };
}

async function findRequestById(request_id) {
  return prisma.account_deletion_requests.findUnique({
    where: { request_id: Number(request_id) },
    include: { users: { select: { user_id: true, user_name: true } } },
  });
}

// Several tables have a real FK to users with no cascade/setNull, so they
// must be detached or removed before the user row can be deleted. Wallet
// tables (wallets, wallet_ledger, wallet_holds, wallet_transaction_logs,
// wallet_transactions) have no FK to users in the schema — they're
// intentionally left untouched so financial records survive account
// deletion. Tables below with nullable user_id are detached (set null);
// tables where user_id is required are deleted outright (their own
// dependents, e.g. event_booking_seats, event_review_helpful, cascade
// automatically via existing FK rules).
async function cleanupUserData(uid) {
  await prisma.$transaction([
    prisma.admin_logs.updateMany({
      where: { user_id: uid },
      data: { user_id: null },
    }),
    prisma.app_ratings.updateMany({
      where: { user_id: uid },
      data: { user_id: null },
    }),
    prisma.event_organizers.updateMany({
      where: { user_id: uid },
      data: { user_id: null },
    }),
    prisma.organizer_revenue_share.updateMany({
      where: { updated_by: uid },
      data: { updated_by: null },
    }),
    prisma.bookings.deleteMany({ where: { user_id: uid } }),
    prisma.event_bookings.deleteMany({ where: { user_id: uid } }),
    prisma.event_payment_sessions.deleteMany({ where: { user_id: uid } }),
    prisma.event_reviews.deleteMany({ where: { user_id: uid } }),
    prisma.event_seat_holds.deleteMany({ where: { user_id: uid } }),
    prisma.reviews.deleteMany({ where: { user_id: uid } }),
  ]);
}

async function approveAndDeleteUser(request_id, resolved_by) {
  const req = await findRequestById(request_id);
  if (!req) return { notFound: true };
  if (req.status !== "pending") return { alreadyResolved: true };

  const uid = Number(req.user_id);

  await cleanupUserData(uid);

  // Mark approved before deleting user — the FK is SetNull, so after user deletion
  // user_id becomes NULL automatically, but status/resolved_at are preserved.
  await prisma.account_deletion_requests.update({
    where: { request_id: Number(request_id) },
    data: {
      status: "approved",
      resolved_at: new Date(),
      resolved_by: resolved_by ? Number(resolved_by) : null,
    },
  });

  // Delete the user — Prisma cascade removes related rows; account_deletion_requests.user_id → SetNull
  await prisma.users.delete({ where: { user_id: uid } });

  return { deleted: true, user_id: uid };
}

// Self-service deletion: an authenticated user deletes their own row from
// users by their own user_id (taken from their access token). Immediate, no
// admin review — App Store 5.1.1(v) only allows a customer-service gate for
// highly-regulated industries, which TabDey is not.
async function selfDeleteAccount(user_id) {
  const uid = Number(user_id);

  await cleanupUserData(uid);
  await prisma.users.delete({ where: { user_id: uid } });

  return { deleted: true, user_id: uid };
}

async function rejectRequest(request_id, resolved_by, reject_note) {
  const req = await findRequestById(request_id);
  if (!req) return { notFound: true };
  if (req.status !== "pending") return { alreadyResolved: true };

  const updated = await prisma.account_deletion_requests.update({
    where: { request_id: Number(request_id) },
    data: {
      status: "rejected",
      resolved_at: new Date(),
      resolved_by: resolved_by ? Number(resolved_by) : null,
      reject_note,
    },
    select: {
      request_id: true,
      status: true,
      reject_note: true,
      resolved_at: true,
    },
  });

  return { rejected: true, data: updated };
}

module.exports = {
  getLatestByUser,
  listRequests,
  approveAndDeleteUser,
  selfDeleteAccount,
  rejectRequest,
};
