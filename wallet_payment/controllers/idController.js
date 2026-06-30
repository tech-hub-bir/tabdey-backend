// controllers/idController.js
const { prisma } = require("../lib/prisma");
const { makeTxnId, makeJournalCode } = require("../utils/idService");

/* =========================
   Helpers
========================= */

async function transactionIdExists(id) {
  const row = await prisma.wallet_transactions.findFirst({
    where: {
      transaction_id: id,
    },
    select: {
      transaction_id: true,
    },
  });

  return !!row;
}

async function journalCodeExists(code) {
  const row = await prisma.wallet_transactions.findFirst({
    where: {
      journal_code: code,
    },
    select: {
      journal_code: true,
    },
  });

  return !!row;
}

async function ensureUniqueTxnId(maxTries = 100) {
  for (let i = 0; i < maxTries; i++) {
    const id = makeTxnId();

    const exists = await transactionIdExists(id);

    if (!exists) return id;
  }

  throw new Error("Failed to generate unique transaction_id.");
}

async function ensureUniqueJournalCode(maxTries = 100) {
  for (let i = 0; i < maxTries; i++) {
    const code = makeJournalCode();

    const exists = await journalCodeExists(code);

    if (!exists) return code;
  }

  throw new Error("Failed to generate unique journal_code.");
}

/**
 * Deduplicate generated IDs within the same response.
 * This protects against rare duplicate generation before DB insert happens.
 */
async function generateUniqueTxnIds(count) {
  const out = [];
  const seen = new Set();

  while (out.length < count) {
    const id = await ensureUniqueTxnId();

    if (seen.has(id)) continue;

    seen.add(id);
    out.push(id);
  }

  return out;
}

/* =========================
   Controllers
========================= */

/**
 * POST /ids/transaction
 * Body: { count?: number }
 * Response: { ok, count, data: [ids] }
 */
async function createTxnIdCtrl(req, res) {
  try {
    const count = Math.max(1, Math.min(100, Number(req.body?.count) || 1));

    const out = await generateUniqueTxnIds(count);

    return res.json({
      ok: true,
      count,
      data: out,
    });
  } catch (err) {
    console.error("createTxnIdCtrl error:", err);

    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
}

/**
 * POST /ids/journal
 * Body: {}
 * Response: { ok, code }
 */
async function createJournalCodeCtrl(_req, res) {
  try {
    const code = await ensureUniqueJournalCode();

    return res.json({
      ok: true,
      code,
    });
  } catch (err) {
    console.error("createJournalCodeCtrl error:", err);

    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
}

/**
 * POST /ids/both
 * Response:
 * {
 *   ok: true,
 *   data: {
 *     transaction_ids: [id1, id2],
 *     journal_code
 *   }
 * }
 */
async function createBothCtrl(_req, res) {
  try {
    const journal_code = await ensureUniqueJournalCode();
    const transaction_ids = await generateUniqueTxnIds(2);

    return res.json({
      ok: true,
      data: {
        transaction_ids,
        journal_code,
      },
    });
  } catch (err) {
    console.error("createBothCtrl error:", err);

    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
}

module.exports = {
  createTxnIdCtrl,
  createJournalCodeCtrl,
  createBothCtrl,
};