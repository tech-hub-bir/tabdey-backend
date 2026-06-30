// src/controllers/rmaLogController.js
const { getRmaLogs, getRmaLogById } = require("../services/rmaLogService");

/**
 * GET /api/rma/logs
 * Query params:
 *   orderNo   (optional)
 *   bfsTxnId  (optional)
 *   tag       (optional)
 *   page      (optional, default 1)
 *   limit     (optional, default 50, max 200)
 */
async function listRmaLogs(req, res, next) {
  try {
    const { orderNo, bfsTxnId, tag, page, limit } = req.query;

    const data = await getRmaLogs({
      orderNo,
      bfsTxnId,
      tag,
      page,
      limit,
    });

    res.json({
      ok: true,
      data,
    });
  } catch (err) {
    console.error("[RMA_LOG] list error:", err);
    next(err);
  }
}

/**
 * GET /api/rma/logs/:id
 */
async function getRmaLog(req, res, next) {
  try {
    const { id } = req.params;
    const log = await getRmaLogById(id);

    if (!log) {
      return res.status(404).json({
        ok: false,
        message: "Log not found",
      });
    }

    res.json({
      ok: true,
      data: log,
    });
  } catch (err) {
    console.error("[RMA_LOG] get error:", err);
    next(err);
  }
}

module.exports = {
  listRmaLogs,
  getRmaLog,
};
