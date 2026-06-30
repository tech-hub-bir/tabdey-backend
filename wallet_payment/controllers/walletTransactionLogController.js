// controllers/walletTransactionLogController.js
const {
  getLogsByTransactionId,
  getLogsByRequestId,
  listWalletTransactionLogs,
} = require("../models/walletTransactionLogModel");

/* =========================
   GET /wallet-transaction-logs
========================= */

async function getAll(req, res) {
  try {
    const {
      request_id,

      transaction_id,
      journal_code,

      wallet_id,
      user_id,

      action,
      status,

      start,
      end,

      limit,
      offset,
    } = req.query || {};

    const logs = await listWalletTransactionLogs({
      request_id,

      transaction_id,
      journal_code,

      wallet_id,
      user_id,

      action,
      status,

      start,
      end,

      limit,
      offset,
    });

    return res.json({
      success: true,
      count: logs.length,
      data: logs,
    });
  } catch (err) {
    console.error("getAll wallet transaction logs error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error.",
      error: err.message,
    });
  }
}

/* =========================
   GET /wallet-transaction-logs/transaction/:transaction_id
========================= */

async function getByTransactionId(req, res) {
  try {
    const { transaction_id } = req.params;
    const { limit } = req.query || {};

    const txid = String(transaction_id || "").trim();

    if (!txid) {
      return res.status(400).json({
        success: false,
        message: "transaction_id is required.",
      });
    }

    const logs = await getLogsByTransactionId(txid, { limit });

    return res.json({
      success: true,
      transaction_id: txid,
      count: logs.length,
      data: logs,
    });
  } catch (err) {
    console.error("getByTransactionId logs error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error.",
      error: err.message,
    });
  }
}

/* =========================
   GET /wallet-transaction-logs/request/:request_id
========================= */

async function getByRequestId(req, res) {
  try {
    const { request_id } = req.params;
    const { limit } = req.query || {};

    const rid = String(request_id || "").trim();

    if (!rid) {
      return res.status(400).json({
        success: false,
        message: "request_id is required.",
      });
    }

    const logs = await getLogsByRequestId(rid, { limit });

    return res.json({
      success: true,
      request_id: rid,
      count: logs.length,
      data: logs,
    });
  } catch (err) {
    console.error("getByRequestId logs error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error.",
      error: err.message,
    });
  }
}

module.exports = {
  getAll,
  getByTransactionId,
  getByRequestId,
};