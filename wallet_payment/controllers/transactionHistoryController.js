// controllers/transactionHistoryController.js
const {
  listByWallet,
  listByUser,
  listAll,
  isValidWalletId,
} = require("../models/transactionHistoryModel");
const { toThimphuString } = require("../utils/time");

// One mapping function for BOTH endpoints
function mapRowForWallet(row, wallet_id) {
  const direction =
    row.tnx_to === wallet_id ? "CR" : row.tnx_from === wallet_id ? "DR" : null;

  return {
    transaction_id: row.transaction_id,
    journal_code: row.journal_code,
    direction, // CR or DR relative to wallet_id
    amount: Number(row.amount),
    wallet_id, // this wallet
    counterparty_wallet_id: direction === "CR" ? row.tnx_from : row.tnx_to,
    note: row.note || null,
    created_at: new Date(row.created_at).toISOString(),
    created_at_local: toThimphuString(row.created_at),
  };
}

/* ---------- GET by wallet ---------- */
async function getByWallet(req, res) {
  try {
    const { wallet_id } = req.params;
    if (!isValidWalletId(wallet_id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid wallet_id." });
    }

    const { limit, cursor, start, end, direction, journal, q } = req.query;
    const { rows, next_cursor } = await listByWallet(wallet_id, {
      limit,
      cursor,
      start,
      end,
      direction: direction ? String(direction).toUpperCase() : null, // 'CR' | 'DR' | null
      journal,
      q,
    });

    res.json({
      success: true,
      count: rows.length,
      next_cursor,
      data: rows.map((r) => mapRowForWallet(r, wallet_id)),
    });
  } catch (e) {
    console.error("getByWallet error:", e);
    res.status(500).json({ success: false, message: "Server error." });
  }
}

/* ---------- GET by user ---------- */
async function getByUser(req, res) {
  try {
    const { user_id } = req.params;
    if (!user_id || isNaN(user_id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid user_id." });

    const { limit, cursor, start, end, direction, journal, q } = req.query;
    const { rows, next_cursor, wallet_id } = await listByUser(user_id, {
      limit,
      cursor,
      start,
      end,
      direction: direction ? String(direction).toUpperCase() : null,
      journal,
      q,
    });

    if (!wallet_id)
      return res
        .status(404)
        .json({ success: false, message: "Wallet not found for this user." });

    res.json({
      success: true,
      count: rows.length,
      next_cursor,
      data: rows.map((r) => mapRowForWallet(r, wallet_id)),
    });
  } catch (e) {
    console.error("getByUser error:", e);
    res.status(500).json({ success: false, message: "Server error." });
  }
}

/* ---------- GET all (admin/global) ---------- */
async function getAll(req, res) {
  try {
    const { limit, cursor, start, end, journal, q } = req.query;
    const { rows, next_cursor } = await listAll({
      limit,
      cursor,
      start,
      end,
      journal,
      q,
    });

    res.json({
      success: true,
      count: rows.length,
      next_cursor,
      data: rows.map((r) => ({
        transaction_id: r.transaction_id,
        journal_code: r.journal_code,
        tnx_from: r.tnx_from,
        tnx_to: r.tnx_to,
        amount: Number(r.amount),
        remark: r.remark,
        note: r.note || null,
        created_at: new Date(r.created_at).toISOString(),
        created_at_local: toThimphuString(r.created_at),
      })),
    });
  } catch (e) {
    console.error("getAll error:", e);
    res.status(500).json({ success: false, message: "Server error." });
  }
}

module.exports = {
  getByWallet,
  getByUser,
  getAll,
};
