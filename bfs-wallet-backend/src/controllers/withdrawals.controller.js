// src/controllers/withdrawals.controller.js
const { withTx } = require("../utils/withTx");
const S = require("../services/withdrawals.service");

const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, e) => {
  const status = e?.status || 500;
  res.status(status).json({ ok: false, error: e?.message || "Server error" });
};

function getNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickUserId(req) {
  return req.user?.id ?? null;
}

function pickAdminId(req) {
  return req.user?.id ?? null;
}

/* USER */
async function createWithdrawal(req, res) {
  try {
    const userId = pickUserId(req);
    if (!userId) return res.status(400).json({ ok: false, error: "user_id is required" });

    const idempotencyKey = req.header("Idempotency-Key") || "";
    const { amount, bank, user_note} = req.body || {};
    console.log("Withdrawal request:", JSON.stringify({ userId, amount, bank, user_note }));
    const data = await withTx((conn) =>
      S.userCreateWithdrawal(conn, {
        userId,
        amountNu: amount,
        bank,
        idempotencyKey,
        userNote: user_note,
      })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function cancelWithdrawal(req, res) {
  try {
    const userId = pickUserId(req);
    if (!userId) return res.status(400).json({ ok: false, error: "user_id is required" });

    const requestId = req.params.id;

    const data = await withTx((conn) =>
      S.userCancelWithdrawal(conn, { userId, requestId })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function listMyWithdrawals(req, res) {
  try {
    const userId = pickUserId(req);
    if (!userId) return res.status(400).json({ ok: false, error: "user_id is required" });

    const { status, limit = 50, offset = 0 } = req.query || {};

    const data = await withTx((conn) =>
      S.userListWithdrawals(conn, {
        userId,
        status: status || null,
        limit: Number(limit),
        offset: Number(offset),
      })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

/* ADMIN */
async function adminList(req, res) {
  try {
    const { status, user_id, from, to, limit = 50, offset = 0 } = req.query || {};

    const data = await withTx((conn) =>
      S.adminListWithdrawals(conn, {
        status: status || null,
        userId: user_id ? Number(user_id) : null,
        from: from || null,
        to: to || null,
        limit: Number(limit),
        offset: Number(offset),
      })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function adminNeedsInfoOne(req, res) {
  try {
    const adminId = pickAdminId(req);
    if (!adminId) return res.status(400).json({ ok: false, error: "admin_id is required (x-admin-id header or body.admin_id)" });

    const requestId = req.params.id;
    const { note } = req.body || {};

    const data = await withTx((conn) =>
      S.adminNeedsInfo(conn, { adminId, requestId, note })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function adminApproveOne(req, res) {
  try {
    const adminId = pickAdminId(req);
    if (!adminId) return res.status(400).json({ ok: false, error: "admin_id is required (x-admin-id header or body.admin_id)" });

    const requestId = req.params.id;
    const { admin_note } = req.body || {};

    const data = await withTx((conn) =>
      S.adminApprove(conn, { adminId, requestId, adminNote: admin_note })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function adminRejectOne(req, res) {
  try {
    const adminId = pickAdminId(req);
    if (!adminId) return res.status(400).json({ ok: false, error: "admin_id is required (x-admin-id header or body.admin_id)" });

    const requestId = req.params.id;
    const { reason } = req.body || {};

    const data = await withTx((conn) =>
      S.adminReject(conn, { adminId, requestId, reason })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function adminMarkPaidOne(req, res) {
  try {
    const adminId = pickAdminId(req);
    if (!adminId) return res.status(400).json({ ok: false, error: "admin_id is required (x-admin-id header or body.admin_id)" });

    const requestId = req.params.id;
    const { bank_reference, note } = req.body || {};

    const data = await withTx((conn) =>
      S.adminMarkPaid(conn, {
        adminId,
        requestId,
        bankReference: bank_reference,
        note,
      })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

async function adminFailOne(req, res) {
  try {
    const adminId = pickAdminId(req);
    if (!adminId) return res.status(400).json({ ok: false, error: "admin_id is required (x-admin-id header or body.admin_id)" });

    const requestId = req.params.id;
    const { reason } = req.body || {};

    const data = await withTx((conn) =>
      S.adminFail(conn, { adminId, requestId, reason })
    );
    ok(res, data);
  } catch (e) {
    fail(res, e);
  }
}

module.exports = {
  createWithdrawal,
  cancelWithdrawal,
  listMyWithdrawals,
  adminList,
  adminNeedsInfoOne,
  adminApproveOne,
  adminRejectOne,
  adminMarkPaidOne,
  adminFailOne,
};
