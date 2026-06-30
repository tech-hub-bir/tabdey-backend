// src/services/withdrawals.service.js
const { safeStr, normalizeNuAmount, genId, cmpDec } = require("../utils/money");
const {
  auditWithdrawal,
  postWalletLedger,
} = require("./walletLedger.service");

/**
 * Matches your DB enum:
 * withdrawal_requests.status ENUM('HELD','NEEDS_INFO','APPROVED','REJECTED','CANCELLED','PAID','FAILED')
 * wallets.status ENUM('ACTIVE','INACTIVE')
 * wallet_ledger.entry_type ENUM('WITHDRAW_REQUEST_DEBIT','WITHDRAW_REFUND','WITHDRAW_PAID')
 */

const POLICY = {
  MIN_NU: "1.00",
  MAX_NU: "500000.00",
  CURRENCY: "BTN",
  ENFORCE_TWO_MAN: false,
  TWO_MAN_THRESHOLD: "20000.00",
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function normalizeBank(bank = {}) {
  const bank_code = safeStr(bank.bank_code);
  const bank_name = safeStr(bank.bank_name);
  const account_no = safeStr(bank.account_no);
  const account_name = safeStr(bank.account_name);

  if (!bank_code || !bank_name || !account_no || !account_name) {
    throw httpError(400, "Bank details are required");
  }
  if (account_no.length < 6) throw httpError(400, "Invalid bank account number");

  return { bank_code, bank_name, account_no, account_name };
}

async function lockWallet(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT id, user_id, amount, status
     FROM wallets
     WHERE user_id = ?
     FOR UPDATE`,
    [userId]
  );

  if (!rows.length) throw httpError(404, "Wallet not found");

  const w = rows[0];
  const st = String(w.status || "").toUpperCase();
  if (st !== "ACTIVE") throw httpError(403, "Wallet is not active");

  return w;
}

async function debitWallet(conn, userId, amount) {
  const [r] = await conn.execute(
    `UPDATE wallets
     SET amount = amount - CAST(? AS DECIMAL(17,2)),
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
       AND status = 'ACTIVE'
       AND amount >= CAST(? AS DECIMAL(17,2))`,
    [amount, userId, amount]
  );

  if (!r || r.affectedRows !== 1) {
    throw httpError(400, "Insufficient wallet balance");
  }
}

async function refundWallet(conn, userId, amount) {
  await conn.execute(
    `UPDATE wallets
     SET amount = amount + CAST(? AS DECIMAL(17,2)),
         updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
       AND status = 'ACTIVE'`,
    [amount, userId]
  );
}

/* =========================================================
   USER create (idempotent)
   - Debits wallet immediately (so funds are held)
   - Creates withdrawal_requests row with status='HELD'
   - Writes withdrawal_audit + wallet_ledger
========================================================= */
async function userCreateWithdrawal(conn, {
  userId,
  amountNu,
  bank,
  idempotencyKey,
  userNote,
}) {
  const amount = normalizeNuAmount(amountNu);
  if (!amount) throw httpError(400, "Invalid amount. Use 100 or 100.50");

  if (cmpDec(amount, POLICY.MIN_NU) < 0) {
    throw httpError(400, `Minimum withdrawal is Nu. ${POLICY.MIN_NU}`);
  }
  if (cmpDec(amount, POLICY.MAX_NU) > 0) {
    throw httpError(400, `Maximum withdrawal is Nu. ${POLICY.MAX_NU}`);
  }

  const idem = safeStr(idempotencyKey);
  if (!idem) throw httpError(400, "Idempotency-Key header is required");

  const bankInfo = normalizeBank(bank);

  // lock wallet row
  await lockWallet(conn, userId);

  // idempotency lock
  const [existing] = await conn.execute(
    `SELECT *
     FROM withdrawal_requests
     WHERE user_id = ? AND idempotency_key = ?
     LIMIT 1
     FOR UPDATE`,
    [userId, idem]
  );
  if (existing.length) return existing[0];

  // debit (held)
  await debitWallet(conn, userId, amount);

  const requestId = genId("wd");

  // create request with HELD
  await conn.execute(
    `INSERT INTO withdrawal_requests
      (request_id, user_id, amount, currency,
       bank_code, bank_name, account_no, account_name,
       status, idempotency_key, user_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'HELD', ?, ?)`,
    [
      requestId,
      userId,
      amount,
      POLICY.CURRENCY,
      bankInfo.bank_code,
      bankInfo.bank_name,
      bankInfo.account_no,
      bankInfo.account_name,
      idem,
      userNote ? String(userNote).slice(0, 255) : null,
    ]
  );

  // audit
  await auditWithdrawal(conn, {
    requestId,
    actorType: "USER",
    actorId: userId,
    action: "CREATE",
    metadata: { amount, bank: bankInfo },
  });

  // ledger (enum matches DB)
  await postWalletLedger(conn, {
    userId,
    entryType: "WITHDRAW_REQUEST_DEBIT",
    amount: `-${amount}`,
    sourceType: "WITHDRAWAL",
    sourceId: requestId,
    note: "Withdrawal requested (held)",
  });

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id = ?`,
    [requestId]
  );
  return rows[0];
}

/* =========================================================
   USER cancel (refund)
   - Allowed in HELD or NEEDS_INFO
   - Refunds wallet
   - Sets status=CANCELLED
   - Writes audit + ledger
========================================================= */
async function userCancelWithdrawal(conn, { userId, requestId }) {
  const rid = safeStr(requestId);
  if (!rid) throw httpError(400, "requestId required");

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id = ? FOR UPDATE`,
    [rid]
  );
  if (!rows.length) throw httpError(404, "Withdrawal request not found");

  const req = rows[0];
  if (Number(req.user_id) !== Number(userId)) throw httpError(403, "Forbidden");

  const st = String(req.status);
  if (!["HELD", "NEEDS_INFO"].includes(st)) {
    throw httpError(400, "Cannot cancel at this stage");
  }

  await lockWallet(conn, userId);
  await refundWallet(conn, userId, String(req.amount));

  await conn.execute(
    `UPDATE withdrawal_requests
     SET status='CANCELLED', updated_at=CURRENT_TIMESTAMP
     WHERE request_id=?`,
    [rid]
  );

  await auditWithdrawal(conn, {
    requestId: rid,
    actorType: "USER",
    actorId: userId,
    action: "CANCEL",
    metadata: null,
  });

  await postWalletLedger(conn, {
    userId,
    entryType: "WITHDRAW_REFUND",
    amount: `${req.amount}`,
    sourceType: "WITHDRAWAL",
    sourceId: rid,
    note: "User cancelled (refund)",
  });

  const [after] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=?`,
    [rid]
  );
  return after[0];
}

/* USER list */
async function userListWithdrawals(conn, { userId, status, limit = 50, offset = 0 }) {
  const params = [userId];
  let where = `WHERE user_id = ?`;

  if (status) {
    where += ` AND status = ?`;
    params.push(String(status));
  }

  params.push(Number(limit), Number(offset));

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

/* =========================================================
   ADMIN list
========================================================= */
async function adminListWithdrawals(conn, { status, userId, from, to, limit = 50, offset = 0 }) {
  const where = [];
  const params = [];

  if (status) { where.push(`status = ?`); params.push(String(status)); }
  if (userId) { where.push(`user_id = ?`); params.push(Number(userId)); }
  if (from) { where.push(`created_at >= ?`); params.push(from); }
  if (to) { where.push(`created_at <= ?`); params.push(to); }

  const sqlWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(Number(limit), Number(offset));

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests ${sqlWhere}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

/* =========================================================
   ADMIN needs info
   - Only HELD -> NEEDS_INFO
========================================================= */
async function adminNeedsInfo(conn, { adminId, requestId, note }) {
  const rid = safeStr(requestId);
  if (!rid) throw httpError(400, "requestId required");

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=? FOR UPDATE`,
    [rid]
  );
  if (!rows.length) throw httpError(404, "Not found");

  const req = rows[0];
  if (String(req.status) !== "HELD") {
    throw httpError(400, "Only HELD can be moved to NEEDS_INFO");
  }

  await conn.execute(
    `UPDATE withdrawal_requests
     SET status='NEEDS_INFO',
         reviewed_by=?,
         reviewed_at=NOW(),
         admin_note=?,
         updated_at=CURRENT_TIMESTAMP
     WHERE request_id=?`,
    [adminId, note ? String(note).slice(0, 255) : null, rid]
  );

  await auditWithdrawal(conn, {
    requestId: rid,
    actorType: "ADMIN",
    actorId: adminId,
    action: "NEEDS_INFO",
    metadata: note ? { note } : null,
  });

  const [after] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=?`,
    [rid]
  );
  return after[0];
}

/* =========================================================
   ADMIN approve
   - HELD/NEEDS_INFO -> APPROVED
========================================================= */
async function adminApprove(conn, { adminId, requestId, adminNote }) {
  const rid = safeStr(requestId);
  if (!rid) throw httpError(400, "requestId required");

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=? FOR UPDATE`,
    [rid]
  );
  if (!rows.length) throw httpError(404, "Not found");

  const req = rows[0];
  if (!["HELD", "NEEDS_INFO"].includes(String(req.status))) {
    throw httpError(400, "Only HELD / NEEDS_INFO can be approved");
  }

  await conn.execute(
    `UPDATE withdrawal_requests
     SET status='APPROVED',
         reviewed_by=?,
         reviewed_at=NOW(),
         approved_by=?,
         approved_at=NOW(),
         admin_note=?,
         updated_at=CURRENT_TIMESTAMP
     WHERE request_id=?`,
    [adminId, adminId, adminNote ? String(adminNote).slice(0, 255) : null, rid]
  );

  await auditWithdrawal(conn, {
    requestId: rid,
    actorType: "ADMIN",
    actorId: adminId,
    action: "APPROVE",
    metadata: adminNote ? { admin_note: adminNote } : null,
  });

  const [after] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=?`,
    [rid]
  );
  return after[0];
}

/* =========================================================
   ADMIN reject (refund)
   - HELD/NEEDS_INFO -> REJECTED
========================================================= */
async function adminReject(conn, { adminId, requestId, reason }) {
  const rid = safeStr(requestId);
  if (!rid) throw httpError(400, "requestId required");

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=? FOR UPDATE`,
    [rid]
  );
  if (!rows.length) throw httpError(404, "Not found");

  const req = rows[0];
  if (!["HELD", "NEEDS_INFO"].includes(String(req.status))) {
    throw httpError(400, "Only HELD / NEEDS_INFO can be rejected");
  }

  // refund
  await lockWallet(conn, Number(req.user_id));
  await refundWallet(conn, Number(req.user_id), String(req.amount));

  await conn.execute(
    `UPDATE withdrawal_requests
     SET status='REJECTED',
         reviewed_by=?,
         reviewed_at=NOW(),
         admin_note=?,
         updated_at=CURRENT_TIMESTAMP
     WHERE request_id=?`,
    [adminId, reason ? String(reason).slice(0, 255) : null, rid]
  );

  await auditWithdrawal(conn, {
    requestId: rid,
    actorType: "ADMIN",
    actorId: adminId,
    action: "REJECT",
    metadata: reason ? { reason } : null,
  });

  await postWalletLedger(conn, {
    userId: req.user_id,
    entryType: "WITHDRAW_REFUND",
    amount: `${req.amount}`,
    sourceType: "WITHDRAWAL",
    sourceId: rid,
    note: reason ? `Admin rejected (refund): ${String(reason).slice(0, 120)}` : "Admin rejected (refund)",
  });

  const [after] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=?`,
    [rid]
  );
  return after[0];
}

/* =========================================================
   ADMIN mark paid (manual bank transfer)
   - APPROVED -> PAID
   - No wallet change (already debited)
========================================================= */
async function adminMarkPaid(conn, { adminId, requestId, bankReference, note }) {
  const rid = safeStr(requestId);
  const ref = safeStr(bankReference);
  if (!rid) throw httpError(400, "requestId required");
  if (!ref) throw httpError(400, "bankReference required");

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=? FOR UPDATE`,
    [rid]
  );
  if (!rows.length) throw httpError(404, "Not found");

  const req = rows[0];
  if (String(req.status) !== "APPROVED") {
    throw httpError(400, "Only APPROVED can be marked PAID");
  }

  if (POLICY.ENFORCE_TWO_MAN && cmpDec(String(req.amount), POLICY.TWO_MAN_THRESHOLD) >= 0) {
    if (req.approved_by && Number(req.approved_by) === Number(adminId)) {
      throw httpError(403, "2-man rule: approver cannot mark paid for large withdrawals");
    }
  }

  await conn.execute(
    `UPDATE withdrawal_requests
     SET status='PAID',
         paid_by=?,
         paid_at=NOW(),
         bank_reference=?,
         admin_note=COALESCE(?, admin_note),
         updated_at=CURRENT_TIMESTAMP
     WHERE request_id=?`,
    [adminId, ref, note ? String(note).slice(0, 255) : null, rid]
  );

  await auditWithdrawal(conn, {
    requestId: rid,
    actorType: "ADMIN",
    actorId: adminId,
    action: "MARK_PAID",
    metadata: { bankReference: ref, note: note || null },
  });

  await postWalletLedger(conn, {
    userId: req.user_id,
    entryType: "WITHDRAW_PAID",
    amount: "0.00",
    sourceType: "WITHDRAWAL",
    sourceId: rid,
    note: note
      ? `Paid manually ref=${ref}: ${String(note).slice(0, 120)}`
      : `Paid manually ref=${ref}`,
  });

  const [after] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=?`,
    [rid]
  );
  return after[0];
}

/* =========================================================
   ADMIN fail (refund)
   - HELD/NEEDS_INFO/APPROVED -> FAILED
========================================================= */
async function adminFail(conn, { adminId, requestId, reason }) {
  const rid = safeStr(requestId);
  if (!rid) throw httpError(400, "requestId required");

  const [rows] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=? FOR UPDATE`,
    [rid]
  );
  if (!rows.length) throw httpError(404, "Not found");

  const req = rows[0];
  if (!["HELD", "NEEDS_INFO", "APPROVED"].includes(String(req.status))) {
    throw httpError(400, "Only HELD/NEEDS_INFO/APPROVED can be failed");
  }

  await lockWallet(conn, Number(req.user_id));
  await refundWallet(conn, Number(req.user_id), String(req.amount));

  await conn.execute(
    `UPDATE withdrawal_requests
     SET status='FAILED',
         reviewed_by=?,
         reviewed_at=NOW(),
         admin_note=?,
         updated_at=CURRENT_TIMESTAMP
     WHERE request_id=?`,
    [adminId, reason ? String(reason).slice(0, 255) : null, rid]
  );

  await auditWithdrawal(conn, {
    requestId: rid,
    actorType: "ADMIN",
    actorId: adminId,
    action: "FAIL",
    metadata: reason ? { reason } : null,
  });

  await postWalletLedger(conn, {
    userId: req.user_id,
    entryType: "WITHDRAW_REFUND",
    amount: `${req.amount}`,
    sourceType: "WITHDRAWAL",
    sourceId: rid,
    note: reason ? `Failed (refund): ${String(reason).slice(0, 120)}` : "Failed (refund)",
  });

  const [after] = await conn.execute(
    `SELECT * FROM withdrawal_requests WHERE request_id=?`,
    [rid]
  );
  return after[0];
}

module.exports = {
  userCreateWithdrawal,
  userCancelWithdrawal,
  userListWithdrawals,
  adminListWithdrawals,
  adminNeedsInfo,
  adminApprove,
  adminReject,
  adminMarkPaid,
  adminFail,
};
