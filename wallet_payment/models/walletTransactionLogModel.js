// models/walletTransactionLogModel.js
const { prisma } = require("../lib/prisma");

/* =========================
   Helpers
========================= */

function toBigIntOrNull(v) {
  if (v == null || v === "") return null;

  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function stringifyPayload(v) {
  if (v == null) return null;

  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({
      unserializable: true,
      value: String(v),
    });
  }
}

function parsePayload(v) {
  if (v == null) return null;

  // If Prisma later returns actual Json object, keep it as object
  if (typeof v !== "string") return v;

  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function toNumberOrNull(v) {
  if (v == null) return null;

  if (typeof v === "bigint") return Number(v);

  if (
    typeof v === "object" &&
    typeof v.toString === "function" &&
    v.constructor?.name === "Decimal"
  ) {
    return Number(v.toString());
  }

  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeLog(row) {
  if (!row) return null;

  return {
    ...row,
    log_id: toNumberOrNull(row.log_id),
    user_id: row.user_id != null ? toNumberOrNull(row.user_id) : null,

    request_payload: parsePayload(row.request_payload),
    response_payload: parsePayload(row.response_payload),
    error_payload: parsePayload(row.error_payload),
  };
}

function cleanLimit(v, fallback = 100, max = 300) {
  return Math.min(Math.max(Number(v) || fallback, 1), max);
}

function cleanOffset(v) {
  return Math.max(Number(v) || 0, 0);
}

function validDateOrNull(v) {
  if (!v) return null;

  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;

  return d;
}

/* =========================
   Create Log
========================= */

async function createWalletTransactionLog({
  request_id = null,

  transaction_id = null,
  journal_code = null,

  wallet_id = null,
  user_id = null,

  action,
  status,
  message = null,

  request_payload = null,
  response_payload = null,
  error_payload = null,

  ip_address = null,
  user_agent = null,
}) {
  const log = await prisma.wallet_transaction_logs.create({
    data: {
      request_id: request_id ? String(request_id).slice(0, 64) : null,

      transaction_id: transaction_id ? String(transaction_id).slice(0, 64) : null,
      journal_code: journal_code ? String(journal_code).slice(0, 64) : null,

      wallet_id: wallet_id ? String(wallet_id).slice(0, 32) : null,
      user_id: toBigIntOrNull(user_id),

      action: String(action || "UNKNOWN").trim().toUpperCase().slice(0, 64),
      status: String(status || "UNKNOWN").trim().toUpperCase().slice(0, 32),
      message: message ? String(message).slice(0, 500) : null,

      /*
       * Your current Prisma schema expects String/Null for payload columns.
       * So we store JSON as string.
       * normalizeLog() parses it back to object when fetching.
       */
      request_payload: stringifyPayload(request_payload),
      response_payload: stringifyPayload(response_payload),
      error_payload: stringifyPayload(error_payload),

      ip_address: ip_address ? String(ip_address).slice(0, 64) : null,
      user_agent: user_agent ? String(user_agent).slice(0, 255) : null,
    },
  });

  return normalizeLog(log);
}

/* =========================
   Fetch Logs
========================= */

async function getLogsByTransactionId(transaction_id, { limit = 100 } = {}) {
  const txid = String(transaction_id || "").trim();

  if (!txid) return [];

  const rows = await prisma.wallet_transaction_logs.findMany({
    where: {
      transaction_id: txid,
    },
    orderBy: {
      created_at: "desc",
    },
    take: cleanLimit(limit, 100, 300),
  });

  return rows.map(normalizeLog);
}

async function getLogsByRequestId(request_id, { limit = 100 } = {}) {
  const rid = String(request_id || "").trim();

  if (!rid) return [];

  const rows = await prisma.wallet_transaction_logs.findMany({
    where: {
      request_id: rid,
    },
    orderBy: {
      created_at: "desc",
    },
    take: cleanLimit(limit, 100, 300),
  });

  return rows.map(normalizeLog);
}

async function listWalletTransactionLogs({
  request_id = null,

  transaction_id = null,
  journal_code = null,

  wallet_id = null,
  user_id = null,

  action = null,
  status = null,

  start = null,
  end = null,

  limit = 100,
  offset = 0,
} = {}) {
  const where = {};

  if (request_id) where.request_id = String(request_id).trim();

  if (transaction_id) where.transaction_id = String(transaction_id).trim();
  if (journal_code) where.journal_code = String(journal_code).trim();

  if (wallet_id) where.wallet_id = String(wallet_id).trim();

  if (user_id) {
    const uid = toBigIntOrNull(user_id);
    if (uid != null) where.user_id = uid;
  }

  if (action) where.action = String(action).trim().toUpperCase();
  if (status) where.status = String(status).trim().toUpperCase();

  const startDate = validDateOrNull(start);
  const endDate = validDateOrNull(end);

  if (startDate || endDate) {
    where.created_at = {};

    if (startDate) where.created_at.gte = startDate;
    if (endDate) where.created_at.lte = endDate;
  }

  const rows = await prisma.wallet_transaction_logs.findMany({
    where,
    orderBy: {
      created_at: "desc",
    },
    take: cleanLimit(limit, 100, 300),
    skip: cleanOffset(offset),
  });

  return rows.map(normalizeLog);
}

module.exports = {
  createWalletTransactionLog,
  getLogsByTransactionId,
  getLogsByRequestId,
  listWalletTransactionLogs,
};