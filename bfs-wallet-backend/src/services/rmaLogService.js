// src/services/rmaLogService.js
const { query } = require("../config/mysql");

/**
 * Insert one raw RMA/BFS log.
 */
async function logRmaPg({ orderNo, bfsTxnId, tag, raw }) {
  try {
    await query(
      `
      INSERT INTO rma_pg_logs (order_no, bfs_txn_id, tag, raw_log)
      VALUES (?, ?, ?, ?)
      `,
      [orderNo || null, bfsTxnId || null, tag || null, raw || ""]
    );
  } catch (e) {
    console.error("[RMA_LOG] insert failed:", e.message || e);
  }
}

/**
 * List logs with optional filters + pagination
 * filters: { orderNo?, bfsTxnId?, tag?, page?, limit? }
 */
async function getRmaLogs({ orderNo, bfsTxnId, tag, page = 1, limit = 50 }) {
  page = Number(page) || 1;
  limit = Number(limit) || 50;
  if (limit > 200) limit = 200;
  if (limit < 1) limit = 50;

  const offset = (page - 1) * limit;

  const where = [];
  const params = [];

  if (orderNo) {
    where.push("order_no = ?");
    params.push(orderNo);
  }

  if (bfsTxnId) {
    where.push("bfs_txn_id = ?");
    params.push(bfsTxnId);
  }

  if (tag) {
    where.push("tag = ?");
    params.push(tag);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // 👇 LIMIT/OFFSET are inlined as safe integers, only WHERE uses placeholders
  const rows = await query(
    `
    SELECT
      id,
      order_no,
      bfs_txn_id,
      tag,
      raw_log,
      created_at
    FROM rma_pg_logs
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
    `,
    params
  );

  const countRows = await query(
    `
    SELECT COUNT(*) AS cnt
    FROM rma_pg_logs
    ${whereSql}
    `,
    params
  );

  const total = countRows?.[0]?.cnt || 0;

  return {
    items: rows,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Get a single log by ID
 */
async function getRmaLogById(id) {
  const rows = await query(
    `
    SELECT
      id,
      order_no,
      bfs_txn_id,
      tag,
      raw_log,
      created_at
    FROM rma_pg_logs
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  logRmaPg,
  getRmaLogs,
  getRmaLogById,
};
