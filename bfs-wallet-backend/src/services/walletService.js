const axios = require("axios");
const { pool } = require("../config/mysql");

const WALLET_SERVICE_BASE_URL =
  (process.env.WALLET_SERVICE_BASE_URL || "https://grab.newedge.bt").replace(
    /\/$/,
    ""
  );
const WALLET_SERVICE_TIMEOUT_MS = Number(
  process.env.WALLET_SERVICE_TIMEOUT_MS || 5000
);

const CREDIT_REMARK = "CR";
const DEBIT_REMARK = "DR";

function generateTxnId() {
  const rand = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0");
  return `WTX${Date.now()}${rand}`;
}

function normalizeRemark(value) {
  if (!value) {
    return CREDIT_REMARK;
  }

  const upper = String(value).toUpperCase();
  if (upper === "CR" || upper === "CREDIT") {
    return CREDIT_REMARK;
  }
  if (upper === "DR" || upper === "DEBIT") {
    return DEBIT_REMARK;
  }
  return CREDIT_REMARK;
}

async function fetchWalletByUserId(userId) {
  if (!userId) {
    throw new Error("User ID is required to fetch wallet details.");
  }

  const url = `${WALLET_SERVICE_BASE_URL}/wallet/wallet/getbyuser/${encodeURIComponent(
    userId
  )}`;

  const response = await axios.get(url, {
    timeout: WALLET_SERVICE_TIMEOUT_MS,
  });

  const payload = response?.data;
  if (!payload?.success || !payload?.data?.wallet_id) {
    throw new Error("Failed to fetch wallet ID for user.");
  }

  return payload.data;
}

/**
 * Credit the user's wallet balance (wallets.amount) atomically
 * and record the credit in wallet_transactions.
 * Returns the updated wallet balance as number.
 */
async function credit(
  userId,
  amount,
  meta = {}
) {
  if (!userId) {
    throw new Error("User ID is required to credit wallet.");
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Amount must be a positive number to credit wallet.");
  }

  const {
    transactionId,
    journalCode = "WALLET_CREDIT",
    tnxFrom = "SYSTEM",
    tnxTo,
    remark,
    note = null,
  } = meta || {};

  const walletInfo = await fetchWalletByUserId(userId);
  const walletId = walletInfo.wallet_id;
  if (!walletId) {
    throw new Error("Wallet ID missing for user.");
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [walletRows] = await conn.execute(
      `
        SELECT id, amount, wallet_id
        FROM wallets
        WHERE wallet_id = ?
        LIMIT 1
        FOR UPDATE
      `,
      [walletId]
    );

    if (!walletRows.length) {
      throw new Error("Wallet not found for user.");
    }

    const wallet = walletRows[0];
    const txnId = transactionId || generateTxnId();
    const toValue = tnxTo || walletId;

    await conn.execute(
      `
        UPDATE wallets
        SET amount = amount + ?, updated_at = NOW()
        WHERE wallet_id = ?
        LIMIT 1
      `,
      [value, walletId]
    );

    const [balanceRows] = await conn.execute(
      `
        SELECT amount
        FROM wallets
        WHERE wallet_id = ?
        LIMIT 1
      `,
      [walletId]
    );

    const normalizedRemark = normalizeRemark(remark);

    await conn.execute(
      `
        INSERT INTO wallet_transactions (
          transaction_id,
          journal_code,
          tnx_from,
          tnx_to,
          amount,
          remark,
          note,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        txnId,
        journalCode,
        tnxFrom,
        toValue,
        value,
        normalizedRemark,
        note,
      ]
    );

    await conn.commit();

    return Number(balanceRows[0]?.amount ?? 0);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  credit,
};
